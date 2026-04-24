import crypto from "node:crypto";

import {
	createOpencodeClient as createOpencodeClientV1,
	type TextPartInput,
} from "@opencode-ai/sdk";
import {
	createOpencodeClient,
	createOpencodeServer,
} from "@opencode-ai/sdk/v2";

import { logger } from "@/logger";
import type { AiMessage, AiSession } from "@shellular/protocol";
import type {
	AIProvider,
	AiEventEmitter,
	CodexPromptOptions,
	FileAttachment,
	ModelSelector,
	ProviderInfo,
	ShareInfo,
} from "./interface";
import { normalizeAiEvent } from "./message-utils";

function getErrorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	return String(err);
}

const SSE_BACKOFF_INITIAL_MS = 500;
const SSE_BACKOFF_CAP_MS = 30_000;
const SSE_MAX_RETRIES = 20;

function redactSensitive(input: unknown): string {
	const text = typeof input === "string" ? input : JSON.stringify(input);
	return text
		.replace(
			/([A-Za-z0-9\-_]{20,}\.[A-Za-z0-9\-_]{20,}\.[A-Za-z0-9\-_]{20,})/g,
			"[redacted_jwt]",
		)
		.replace(
			/(password|token|authorization|resumeToken|x-manager-password)\s*[:=]\s*["']?[^"',\s}]+/gi,
			"$1=[redacted]",
		)
		.replace(/[A-Za-z0-9+/=_-]{40,}/g, "[redacted_secret]");
}

function requireData<T>(
	response: { data?: T; error?: unknown },
	label: string,
): T {
	if (!response.data) {
		const errMsg = response.error
			? typeof response.error === "string"
				? response.error
				: JSON.stringify(response.error)
			: `${label} returned no data`;
		logger.error(
			`${label} failed:`,
			redactSensitive(errMsg),
			"raw response:",
			redactSensitive(JSON.stringify(response).substring(0, 500)),
		);
		throw new Error(errMsg);
	}
	return response.data;
}

function normalizeDate(val: unknown): number | undefined {
	if (!val) return undefined;
	if (typeof val === "number") {
		// If it's less than 1e11, it's likely seconds (1e11 sec is year 5138)
		if (val < 1e11) return val * 1000;
		return val;
	}
	if (typeof val === "string") {
		const parsed = Date.parse(val);
		if (!Number.isNaN(parsed)) return parsed;
	}
	return undefined;
}

interface SseRawEvent {
	type?: string;
	payload?: SseRawEvent;
	properties?: Record<string, unknown>;
}

interface PermissionEntry {
	id?: unknown;
	sessionId?: string;
	tool?: { messageID?: unknown; callID?: unknown };
	permission?: string;
	title?: string;
	metadata?: unknown;
}

interface QuestionEntry {
	id?: unknown;
	sessionId?: string;
	questions?: unknown[];
	tool?: unknown;
}

interface FetchOptions {
	method?: string;
	body?: unknown;
}

export class OpenCodeProvider implements AIProvider {
	private _client: ReturnType<typeof createOpencodeClient> | null = null;
	private _clientV1: ReturnType<typeof createOpencodeClientV1> | null = null;
	private _server: Awaited<ReturnType<typeof createOpencodeServer>> | null =
		null;
	private authHeader: string;
	private lastActiveSessionId: string | null = null;
	private shuttingDown = false;
	private emitter: AiEventEmitter | null = null;
	private knownPendingPermissionIds = new Set<string>();
	private knownPendingQuestionIds = new Set<string>();

	constructor() {
		const opencodeUsername = "shellular";
		const opencodePassword = crypto.randomBytes(32).toString("base64url");
		this.authHeader = `Basic ${Buffer.from(`${opencodeUsername}:${opencodePassword}`).toString("base64")}`;

		process.env.OPENCODE_SERVER_USERNAME = opencodeUsername;
		process.env.OPENCODE_SERVER_PASSWORD = opencodePassword;
	}

	async init(): Promise<void> {
		logger.debug("Starting OpenCode...");

		this._server = await createOpencodeServer({
			hostname: "127.0.0.1",
			port: 0,
			timeout: 15000,
		});

		logger.debug(`OpenCode server listening on ${this._server.url}`);

		this._client = createOpencodeClient({
			baseUrl: this._server.url,
			headers: { Authorization: this.authHeader },
			directory: undefined,
		});

		this._clientV1 = createOpencodeClientV1({
			baseUrl: this._server.url,
			headers: { Authorization: this.authHeader },
			directory: undefined,
		});

		logger.debug("OpenCode ready.\n");
	}

	get client() {
		if (!this._client) {
			throw new Error("OpenCode client is not ready");
		}

		return this._client;
	}

	get clientV1() {
		if (!this._clientV1) {
			throw new Error("OpenCode client is not ready");
		}

		return this._clientV1;
	}

	get server() {
		if (!this._server) {
			throw new Error("OpenCode server is not ready");
		}

		return this._server;
	}

	async destroy(): Promise<void> {
		this.shuttingDown = true;
		this.authHeader = "";
		this.server.close();
	}

	subscribe(emitter: AiEventEmitter): () => void {
		this.emitter = emitter;
		this.shuttingDown = false;
		this.runSseLoop();
		return () => {
			this.emitter = null;
		};
	}

	setActiveSession(sessionId: string): void {
		this.lastActiveSessionId = sessionId;
	}

	async createSession(
		_clientId: string,
		prompt: string,
		workspacePath: string,
	) {
		try {
			const response = await this.client.session.create({ title: prompt });
			const raw = requireData(response, "session.create") as Record<
				string,
				unknown
			>;
			return this.normalizeSession(raw, prompt, workspacePath);
		} catch (err) {
			logger.error(
				"createSession exception:",
				redactSensitive(getErrorMessage(err)),
			);
			throw err;
		}
	}

	async listSessions(_clientId: string) {
		try {
			const response = await this.client.experimental.session.list({
				roots: true,
			});
			const data = requireData(response, "session.list") as
				| Record<string, unknown>
				| unknown[];
			const rawSessions = Array.isArray(data)
				? data
				: (data as Record<string, unknown>).data ||
					(data as Record<string, unknown>).threads ||
					[];

			const sessions = (rawSessions as Record<string, unknown>[]).map((s) =>
				this.normalizeSession(s),
			);

			sessions.sort((a, b) => b.updatedAt - a.updatedAt);

			return sessions;
		} catch (err) {
			logger.error("listSessions exception:", getErrorMessage(err));
			throw err;
		}
	}

	async getSession(_clientId: string, id: string) {
		const response = await this.clientV1.session.get({ path: { id } });
		const raw = requireData(response, "session.get") as Record<string, unknown>;
		return this.normalizeSession(raw);
	}

	async deleteSession(_clientId: string, id: string) {
		const response = await this.clientV1.session.delete({ path: { id } });
		return Boolean(requireData(response, "session.delete"));
	}

	async getMessages(_clientId: string, sessionId: string) {
		try {
			const response = await this.clientV1.session.messages({
				path: { id: sessionId },
			});
			const raw = requireData(response, "session.messages") as Array<{
				info: Record<string, unknown>;
				parts: unknown[];
			}>;
			const messages: AiMessage[] = raw.map((m) => ({
				id: m.info.id as string,
				role: m.info.role as "user" | "assistant",
				parts: (m.parts || []) as AiMessage["parts"],
				timestamp: normalizeDate(m.info.time) ?? Date.now(),
			}));
			return messages;
		} catch (err) {
			logger.error("getMessages exception:", getErrorMessage(err));
			throw err;
		}
	}

	async prompt(
		clientId: string,
		sessionId: string,
		text: string,
		model?: ModelSelector,
		agent?: string,
		files: FileAttachment[] = [],
		codexOptions?: CodexPromptOptions,
	): Promise<{ ack: true }> {
		void codexOptions;
		if (sessionId) this.lastActiveSessionId = sessionId;

		this.sendPromptAsync(sessionId, text, model, agent, files).catch(
			(err: unknown) => {
				logger.error("prompt error:", getErrorMessage(err));
				this.emitter?.(clientId, {
					type: "prompt_error",
					properties: { sessionId, error: getErrorMessage(err) },
				});
			},
		);

		return { ack: true };
	}

	async abort(sessionId: string): Promise<Record<string, never>> {
		await this.clientV1.session.abort({ path: { id: sessionId } });
		return {};
	}

	async agents(_clientId: string) {
		try {
			const response = await this.client.app.agents();
			return requireData(response, "app.agents");
		} catch (err) {
			logger.error("getAgents exception:", getErrorMessage(err));
			throw err;
		}
	}

	async providers(_clientId: string): Promise<ProviderInfo> {
		try {
			const response = await this.client.config.providers();
			const data = requireData(response, "config.providers") as {
				providers: unknown[];
				default: Record<string, string>;
			};
			return { providers: data.providers, default: data.default };
		} catch (err) {
			logger.error("getProviders exception:", getErrorMessage(err));
			throw err;
		}
	}

	async setAuth(
		providerId: string,
		key: string,
	): Promise<Record<string, never>> {
		await this.clientV1.auth.set({
			path: { id: providerId },
			body: { type: "api", key },
		});
		return {};
	}

	async command(
		sessionId: string,
		command: string,
		args: string,
	): Promise<{ result: unknown }> {
		const response = await this.clientV1.session.command({
			path: { id: sessionId },
			body: { command, arguments: args },
		});
		return { result: response.data ?? null };
	}

	async revert(
		sessionId: string,
		messageId: string,
	): Promise<Record<string, never>> {
		await this.clientV1.session.revert({
			path: { id: sessionId },
			body: { messageID: messageId },
		});
		return {};
	}

	async unrevert(sessionId: string): Promise<Record<string, never>> {
		await this.clientV1.session.unrevert({ path: { id: sessionId } });
		return {};
	}

	async share(sessionId: string): Promise<{ share: ShareInfo }> {
		const response = await this.clientV1.session.share({
			path: { id: sessionId },
		});
		return { share: requireData(response, "session.share") };
	}

	async permissionReply(
		sessionId: string,
		permissionId: string,
		response: "once" | "always" | "reject",
	): Promise<Record<string, never>> {
		await this.clientV1.postSessionIdPermissionsPermissionId({
			path: { id: sessionId, permissionID: permissionId },
			body: { response },
		});
		return {};
	}

	async questionReply(
		sessionId: string,
		clientId: string,
		questionId: string,
		answers: string[][],
	): Promise<Record<string, never>> {
		await this.fetchOpenCodeJson(
			`/question/${encodeURIComponent(questionId)}/reply`,
			{
				method: "POST",
				body: { answers },
			},
		);
		this.knownPendingQuestionIds.delete(questionId);
		this.emitter?.(clientId, {
			type: "question.replied",
			properties: { sessionId: sessionId, requestID: questionId, answers },
		});
		return {};
	}

	async questionReject(
		sessionId: string,
		clientId: string,
		questionId: string,
	): Promise<Record<string, never>> {
		await this.fetchOpenCodeJson(
			`/question/${encodeURIComponent(questionId)}/reject`,
			{
				method: "POST",
			},
		);
		this.knownPendingQuestionIds.delete(questionId);
		this.emitter?.(clientId, {
			type: "question.rejected",
			properties: { sessionId: sessionId, requestID: questionId },
		});
		return {};
	}

	private async runSseLoop(): Promise<void> {
		let attempt = 0;
		const backoffMs = (n: number): number => {
			const base = Math.min(
				SSE_BACKOFF_INITIAL_MS * 2 ** n,
				SSE_BACKOFF_CAP_MS,
			);
			return Math.round(base + Math.random() * base * 0.3);
		};

		while (!this.shuttingDown) {
			try {
				if (attempt > 0 && this.lastActiveSessionId) {
					const checkResp = await this.client.session.get({
						sessionID: this.lastActiveSessionId,
					});
					if (checkResp.error) {
						const gcSessionId = this.lastActiveSessionId;
						this.lastActiveSessionId = null;
						// TODO: broadcast this event to all clients, not just the one that had the active session (requires some refactoring to track which client has which active session)
						this.emitter?.("defaultClientId", {
							type: "session_gc",
							properties: { sessionId: gcSessionId },
						});
					}
				}
				if (attempt > 0) await this.reconcileOpenCodeState("defaultClientId");

				const events = await this.client.event.subscribe();
				attempt = 0;

				for await (const raw of events.stream) {
					if (this.shuttingDown) return;
					const parsed = raw as SseRawEvent;
					const base =
						parsed?.payload && typeof parsed.payload === "object"
							? parsed.payload
							: parsed;
					if (!base || typeof base.type !== "string") continue;

					this.trackPermissionEvent(base.type, base.properties || {});

					// Normalize event to ensure consistent structure
					const normalized = normalizeAiEvent({
						type: base.type,
						properties: base.properties || {},
					});

					this.emitter?.("defaultClientId", normalized);
				}
			} catch (err) {
				if (this.shuttingDown) return;
				attempt++;
				const delay = backoffMs(attempt - 1);
				if (attempt >= SSE_MAX_RETRIES) {
					this.emitter?.("defaultClientId", {
						type: "sse_dead",
						properties: { error: getErrorMessage(err), attempts: attempt },
					});
					return;
				}
				await new Promise<void>((resolve) => setTimeout(resolve, delay));
			}
		}
	}

	private async sendPromptAsync(
		sessionId: string,
		text: string,
		model?: ModelSelector,
		agent?: string,
		files: FileAttachment[] = [],
	): Promise<void> {
		if (!this.client) throw new Error("OpenCode client is not ready");

		const body: Parameters<typeof this.clientV1.session.prompt>[0]["body"] = {
			parts: [
				...(text.trim().length > 0
					? [{ type: "text", text } as TextPartInput]
					: []),
				...files,
			],
			...(model ? { model } : {}),
			...(agent ? { agent } : {}),
		};

		const response = await this.clientV1.session.prompt({
			path: { id: sessionId },
			body: body,
		});

		if ("error" in response && response.error) {
			const errObj = response.error;
			const detail =
				typeof errObj === "string" ? errObj : JSON.stringify(errObj);
			throw new Error(`OpenCode prompt failed: ${detail}`);
		}
	}

	private async reconcileOpenCodeState(clientId: string): Promise<void> {
		await Promise.allSettled([
			this.refreshSessionsMetadata(clientId),
			this.refreshPendingPermissions(clientId),
			this.refreshPendingQuestions(clientId),
			this.refreshSessionStatuses(clientId),
		]);
	}

	private normalizeSession(
		raw: Record<string, unknown>,
		prompt?: string,
		workspacePath?: string,
	): AiSession {
		const {
			id,
			name,
			title,
			preview,
			slug,
			directory,
			projectID,
			project,
			summary,
			status,
			version,
			archived,
			createdAt,
			created_at,
			updatedAt,
			updated_at,
			time,
			...rest
		} = raw;

		const resolvedTitle =
			prompt ||
			(name as string) ||
			(title as string) ||
			(preview as string) ||
			"Conversation";

		const createdMs =
			normalizeDate(createdAt ?? created_at) ??
			normalizeDate(
				typeof time === "object" && time !== null
					? (time as Record<string, unknown>).created
					: undefined,
			) ??
			Date.now();
		const updatedMs =
			normalizeDate(updatedAt ?? updated_at) ??
			normalizeDate(
				typeof time === "object" && time !== null
					? (time as Record<string, unknown>).updated
					: undefined,
			) ??
			createdMs;

		const opencodeExtra: Record<string, unknown> = {};
		if (slug) opencodeExtra.slug = slug;
		if (projectID) opencodeExtra.projectID = projectID;
		if (project) opencodeExtra.project = project;
		if (summary) opencodeExtra.summary = summary;
		if (status) opencodeExtra.status = status;
		if (version) opencodeExtra.version = version;
		for (const [k, v] of Object.entries(rest)) {
			opencodeExtra[k] = v;
		}

		return {
			id: (id as string) || String(Date.now()),
			title: resolvedTitle,
			createdAt: createdMs,
			updatedAt: updatedMs,
			workspacePath: workspacePath,
		};
	}

	private async refreshSessionsMetadata(clientId: string): Promise<void> {
		const response = await this.client.session.list();
		const sessions = Array.isArray(response.data) ? response.data : [];
		for (const session of sessions) {
			this.emitter?.(clientId, {
				type: "session.updated",
				properties: { info: session as Record<string, unknown> },
			});
		}
	}

	private async refreshPendingPermissions(clientId: string): Promise<void> {
		const permissionApi = (
			this.client as unknown as {
				permission?: { list: () => Promise<{ data?: unknown }> };
			}
		)?.permission;
		if (!permissionApi?.list) return;
		const response = await permissionApi.list();
		const data = Array.isArray(response.data) ? response.data : [];
		const nextIds = new Set<string>();

		for (const entry of data) {
			const p = entry as PermissionEntry;
			const id = String(p.id);
			nextIds.add(id);
			if (this.knownPendingPermissionIds.has(id)) continue;
			this.knownPendingPermissionIds.add(id);
			this.emitter?.(clientId, {
				type: "permission.updated",
				properties: {
					id,
					sessionId: p.sessionId || p.sessionId,
					messageID: p.tool?.messageID,
					callID: p.tool?.callID,
					type: p.permission || "permission",
					title: p.title || p.permission || "Permission requested",
					metadata: p.metadata || p,
				},
			});
		}
		for (const id of Array.from(this.knownPendingPermissionIds)) {
			if (!nextIds.has(id)) {
				this.knownPendingPermissionIds.delete(id);
				this.emitter?.(clientId, {
					type: "permission.replied",
					properties: { permissionId: id },
				});
			}
		}
	}

	private async refreshPendingQuestions(clientId: string): Promise<void> {
		const data = (await this.fetchOpenCodeJson("/question", {
			method: "GET",
		})) as QuestionEntry[];
		const questions = Array.isArray(data) ? data : [];
		const nextIds = new Set<string>();
		for (const entry of questions) {
			const q = entry;
			const id = String(q.id);
			const sessionId = q.sessionId || q.sessionId;
			if (!id || !sessionId) continue;
			nextIds.add(id);
			if (this.knownPendingQuestionIds.has(id)) continue;
			this.knownPendingQuestionIds.add(id);
			this.emitter?.(clientId, {
				type: "question.asked",
				properties: {
					id,
					sessionId,
					questions: q.questions || [],
					tool: q.tool,
				},
			});
		}
		for (const id of Array.from(this.knownPendingQuestionIds)) {
			if (!nextIds.has(id)) this.knownPendingQuestionIds.delete(id);
		}
	}

	private async fetchOpenCodeJson(
		pathname: string,
		options: FetchOptions = {},
	): Promise<unknown> {
		const url = new URL(pathname, this.server.url);
		const response = await fetch(url, {
			method: options.method || "GET",
			headers: {
				...(this.authHeader && { Authorization: this.authHeader }),
				accept: "application/json",
				...(options.body ? { "Content-Type": "application/json" } : {}),
			},
			...(options.body ? { body: JSON.stringify(options.body) } : {}),
		});
		if (!response.ok)
			throw new Error(`OpenCode request failed (${response.status})`);
		return response.json().catch(() => null);
	}

	private async refreshSessionStatuses(clientId: string): Promise<void> {
		const payload = (await this.fetchOpenCodeJson("/session/status")) as Record<
			string,
			unknown
		>;
		if (!payload || typeof payload !== "object") return;
		for (const [sessionId, status] of Object.entries(payload)) {
			this.emitter?.(clientId, {
				type: "session.status",
				properties: { sessionId: sessionId, status },
			});
		}
	}

	private trackPermissionEvent(
		type: string,
		properties: Record<string, unknown>,
	): void {
		if (type === "permission.updated") {
			if (properties.id)
				this.knownPendingPermissionIds.add(String(properties.id));
			return;
		}
		if (type === "permission.replied") {
			const id =
				properties.permissionId || properties.requestID || properties.id;
			if (id) this.knownPendingPermissionIds.delete(String(id));
		}
		if (type === "question.asked") {
			if (properties.id)
				this.knownPendingQuestionIds.add(String(properties.id));
			return;
		}
		if (type === "question.replied" || type === "question.rejected") {
			const id = properties.requestID || properties.questionId || properties.id;
			if (id) this.knownPendingQuestionIds.delete(String(id));
		}
	}
}

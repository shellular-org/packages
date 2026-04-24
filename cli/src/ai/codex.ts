import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

import type { AiMessage, AiSession } from "@shellular/protocol";

import { logger } from "@/logger";
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

// ─── JSON-RPC types ────────────────────────────────────────────────────────

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number | string;
	method: string;
	params?: unknown;
}

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: number | string | null;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

type JsonRpcOutbound = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

interface JsonRpcInboundMessage {
	jsonrpc?: "2.0";
	method?: string;
	id?: number | string | null;
	result?: unknown;
	error?: { code?: number; message?: string; data?: unknown };
	params?: unknown;
}

// ─── Codex domain types ────────────────────────────────────────────────────

interface CodexSession {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	archived?: boolean;
	activeTurnId?: string;
	cwd?: string;
	messages: AiMessage[];
}

interface ThreadListEntry {
	id: string;
	title?: string;
	name?: string;
	preview?: string;
	createdAt?: number;
	created_at?: number;
	updatedAt?: number;
	updated_at?: number;
	archived?: boolean;
	cwd?: string;
	status?: { type: string };
	ephemeral?: boolean;
	modelProvider?: string;
}

interface ThreadStartResponse {
	thread?: {
		id: string;
		preview?: string;
		name?: string;
		ephemeral?: boolean;
		modelProvider?: string;
		createdAt?: number;
	};
}

interface ThreadReadResponse {
	thread?: {
		turns?: CodexTurn[];
		status?: { type: string };
	};
}

interface CodexTurn {
	id?: string;
	createdAt?: unknown;
	status?: string;
	items?: CodexThreadItem[];
	error?: null | {
		message?: string;
		codexErrorInfo?: string;
		additionalDetails?: string;
	};
}

interface CodexTextInputItem {
	type: "text";
	text: string;
}

interface CodexImageInputItem {
	type: "image";
	url: string;
	mime?: string;
	alt?: string;
}

interface CodexLocalImageInputItem {
	type: "localImage";
	path: string;
}

type CodexUserContentItem =
	| CodexTextInputItem
	| CodexImageInputItem
	| CodexLocalImageInputItem;

interface CodexUserMessageItem {
	type: "userMessage";
	id?: string;
	content?: CodexUserContentItem[];
}

interface CodexAgentMessageItem {
	type: "agentMessage";
	id?: string;
	text?: string;
	phase?: string;
}

interface CodexReasoningItem {
	type: "reasoning";
	id?: string;
	summary?: string;
	content?: string;
}

interface CodexPlanItem {
	type: "plan";
	id?: string;
	text?: string;
}

interface CodexCommandExecutionItem {
	type: "commandExecution";
	id?: string;
	command?: string;
	cwd?: string;
	aggregatedOutput?: string;
	exitCode?: number;
	status?: string;
}

interface CodexFileChange {
	path?: string;
	kind?: string;
	diff?: string;
}

interface CodexFileChangeItem {
	type: "fileChange";
	id?: string;
	changes?: CodexFileChange[];
	status?: string;
}

interface CodexMcpToolCallItem {
	type: "mcpToolCall";
	id?: string;
	server?: string;
	tool?: string;
	status?: string;
	arguments?: unknown;
	result?: unknown;
	error?: unknown;
}

interface CodexDynamicToolCallItem {
	type: "dynamicToolCall";
	id?: string;
	tool?: string;
	status?: string;
	arguments?: unknown;
	contentItems?: unknown;
	success?: boolean;
	durationMs?: number;
}

interface CodexCollabToolCallItem {
	type: "collabToolCall";
	id?: string;
	tool?: string;
	status?: string;
	senderThreadId?: string;
	receiverThreadId?: string;
	newThreadId?: string;
	prompt?: string;
	agentStatus?: unknown;
}

interface CodexWebSearchItem {
	type: "webSearch";
	id?: string;
	query?: string;
	action?: unknown;
}

interface CodexImageViewItem {
	type: "imageView";
	id?: string;
	path?: string;
}

interface CodexReviewModeItem {
	type: "enteredReviewMode" | "exitedReviewMode";
	id?: string;
	review?: unknown;
}

interface CodexContextCompactionItem {
	type: "contextCompaction";
	id?: string;
}

type CodexThreadItem =
	| CodexUserMessageItem
	| CodexAgentMessageItem
	| CodexPlanItem
	| CodexReasoningItem
	| CodexCommandExecutionItem
	| CodexFileChangeItem
	| CodexMcpToolCallItem
	| CodexDynamicToolCallItem
	| CodexCollabToolCallItem
	| CodexWebSearchItem
	| CodexImageViewItem
	| CodexReviewModeItem
	| CodexContextCompactionItem
	| { type?: string; id?: string; [key: string]: unknown };

interface CodexModelItem {
	id: string;
	model: string;
	displayName?: string;
	name?: string;
	description?: string;
	hidden?: boolean;
	defaultReasoningEffort?: string;
	supportedReasoningEfforts?: Array<{
		reasoningEffort: string;
		description?: string;
	}>;
	upgrade?: string;
	inputModalities?: string[];
	supportsPersonality?: boolean;
	isDefault?: boolean;
}

interface ModelListResponse {
	data?: CodexModelItem[];
	nextCursor?: string | null;
}

interface ThreadListResponse {
	data?: ThreadListEntry[];
	nextCursor?: string | null;
}

// ─── Notification param types ─────────────────────────────────────────────

interface TurnStartedParams {
	threadId?: string;
	turn: {
		id: string;
		items: unknown[];
		status: string;
		error: null | unknown;
	};
}

interface TurnCompletedParams {
	threadId?: string;
	turn: {
		id: string;
		status: string;
		items?: unknown[];
		error?: null | {
			message?: string;
			codexErrorInfo?: string;
			additionalDetails?: string;
		};
	};
}

interface AgentMessageDeltaParams {
	itemId?: string;
	text?: string;
}

interface ReasoningTextDeltaParams {
	itemId?: string;
	text?: string;
}

interface TurnStatusParams {
	threadId?: string;
	turnId?: string;
	status?: { type: string; activeFlags?: string[] };
}

// ─── Pending RPC ─────────────────────────────────────────────────────────────

interface PendingRpc {
	resolve: (result: unknown) => void;
	reject: (err: Error) => void;
}

interface PendingPermission {
	sessionId: string;
	requestId: number | string;
	method: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function joinStreamingText(previousText: string, nextChunk: string): string {
	if (!previousText) return nextChunk;
	if (nextChunk.startsWith(previousText)) return nextChunk;
	if (previousText.endsWith(nextChunk)) return previousText;
	const maxOverlap = Math.min(previousText.length, nextChunk.length);
	for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
		if (previousText.slice(-overlap) === nextChunk.slice(0, overlap)) {
			return previousText + nextChunk.slice(overlap);
		}
	}
	return previousText + nextChunk;
}

function normalizeDate(val: unknown): number | undefined {
	if (!val) return undefined;
	if (typeof val === "number") {
		if (val < 1e11) return val * 1000;
		return val;
	}
	if (typeof val === "string") {
		const parsed = Date.parse(val);
		if (!Number.isNaN(parsed)) return parsed;
	}
	return undefined;
}

function getErrorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	return String(err);
}

function contentItemToMessagePart(
	item: CodexUserContentItem,
): AiMessage["parts"][number] | null {
	if (item.type === "text") {
		return { type: "text", text: item.text };
	}
	if (item.type === "image") {
		return {
			type: "image",
			src: item.url,
			mime: item.mime,
			alt: item.alt,
		};
	}
	if (item.type === "localImage") {
		return {
			type: "image",
			src: `file://${item.path}`,
		};
	}
	return null;
}

function getUserMessageContent(item: CodexThreadItem): CodexUserContentItem[] {
	if (item.type !== "userMessage" || !Array.isArray(item.content)) return [];
	return item.content;
}

function getFileChanges(item: CodexThreadItem): CodexFileChange[] {
	if (item.type !== "fileChange" || !Array.isArray(item.changes)) return [];
	return item.changes;
}

function normalizeFileChangeDiff(
	diff: string | undefined,
): { old: string; new: string } | undefined {
	if (!diff) return undefined;
	return { old: "", new: diff };
}

function fallbackPartForItem(
	item: CodexThreadItem,
): AiMessage["parts"][number] {
	if (item.type === "plan") {
		return { type: "plan", content: (item.text as string) ?? "" };
	}
	if (item.type === "webSearch") {
		return {
			type: "web_reference",
			url: item.query as string,
			content: item.action as string,
		};
	}
	if (item.type === "imageView") {
		return { type: "image", src: item.path as string };
	}
	if (item.type === "enteredReviewMode" || item.type === "exitedReviewMode") {
		return {
			id: item.id ?? "",
			type: "tool_call",
			name: item.type,
			title: item.review as string,
		};
	}
	if (item.type === "contextCompaction") {
		return { id: item.id ?? "", type: "tool_call", name: "contextCompaction" };
	}
	return { id: item.id ?? "", type: "tool_call", name: item.type ?? "unknown" };
}

function turnToMessages(turn: CodexTurn): AiMessage[] {
	const timestamp = normalizeDate(turn.createdAt) ?? Date.now();
	const turnId = turn.id ?? "";
	const items = Array.isArray(turn.items) ? turn.items : [];
	const messages: AiMessage[] = [];

	for (const item of items) {
		if (!item?.type) continue;

		if (item.type === "userMessage") {
			const parts = getUserMessageContent(item)
				.map((contentItem) => contentItemToMessagePart(contentItem))
				.filter((part): part is AiMessage["parts"][number] => part !== null);
			if (parts.length > 0) {
				messages.push({
					id: item.id ?? `${turnId}:user`,
					role: "user",
					parts,
					timestamp,
				});
			}
			continue;
		}

		if (item.type === "agentMessage") {
			const text = (item.text ?? "") as string;
			if (text) {
				messages.push({
					id: item.id ?? `${turnId}:assistant`,
					role: "assistant",
					parts: [{ type: "text", text }],
					timestamp,
				});
			}
			continue;
		}

		if (item.type === "plan") {
			if (item.text) {
				messages.push({
					id: item.id ?? `${turnId}:plan`,
					role: "assistant",
					parts: [fallbackPartForItem(item)],
					timestamp,
				});
			}
			continue;
		}

		if (item.type === "reasoning") {
			if (item.summary || item.content) {
				messages.push({
					id: item.id ?? `${turnId}:reasoning`,
					role: "assistant",
					parts: [
						{
							type: "reasoning",
							summary: item.summary as string,
							content: item.content as string,
						},
					],
					timestamp,
				});
			}
			continue;
		}

		if (item.type === "mcpToolCall") {
			messages.push({
				id: item.id ?? `${turnId}:mcp-tool`,
				role: "assistant",
				parts: [
					{
						type: "tool_call",
						id: item.id ?? `${turnId}:mcp-tool`,
						name: (item.server && item.tool
							? `${item.server}/${item.tool}`
							: (item.tool ?? "mcpToolCall")) as string,
						arguments: JSON.stringify(item.arguments),
						status: item.status as string,
						output: (item.result ?? item.error) as string,
					},
				],
				timestamp,
			});
			continue;
		}

		if (item.type === "dynamicToolCall") {
			messages.push({
				id: item.id ?? `${turnId}:dynamic-tool`,
				role: "assistant",
				parts: [
					{
						type: "tool_call",
						id: item.id ?? `${turnId}:dynamic-tool`,
						name: (item.tool as string) ?? "dynamicToolCall",
						arguments: JSON.stringify(item.arguments),
						status: item.status as string,
						output: JSON.stringify(item.contentItems),
					},
				],
				timestamp,
			});
			continue;
		}

		if (item.type === "collabToolCall") {
			messages.push({
				id: item.id ?? `${turnId}:collab-tool`,
				role: "assistant",
				parts: [
					{
						type: "tool_call",
						id: item.id ?? `${turnId}:collab-tool`,
						name: (item.tool as string) ?? "collabToolCall",
						arguments: JSON.stringify({
							senderThreadId: item.senderThreadId,
							receiverThreadId: item.receiverThreadId,
							newThreadId: item.newThreadId,
							prompt: item.prompt,
						}),
						status: item.status as string,
						output: item.agentStatus as string,
					},
				],
				timestamp,
			});
			continue;
		}

		if (item.type === "commandExecution") {
			if (item.command) {
				messages.push({
					id: item.id ?? `${turnId}:command`,
					role: "assistant",
					parts: [
						{
							type: "command",
							command: item.command as string,
							cwd: item.cwd as string,
							output: item.aggregatedOutput as string,
							exitCode: item.exitCode as number,
							status: item.status as string,
						},
					],
					timestamp,
				});
			}
			continue;
		}

		if (
			item.type === "webSearch" ||
			item.type === "imageView" ||
			item.type === "enteredReviewMode" ||
			item.type === "exitedReviewMode" ||
			item.type === "contextCompaction"
		) {
			messages.push({
				id: item.id ?? `${turnId}:${item.type}`,
				role: "assistant",
				parts: [fallbackPartForItem(item)],
				timestamp,
			});
			continue;
		}

		if (item.type === "fileChange") {
			const parts = getFileChanges(item)
				.filter((change) => !!change.path && !!change.kind)
				.map((change) => ({
					type: "file_change" as const,
					path: change.path as string,
					kind: change.kind as string,
					diff: normalizeFileChangeDiff(change.diff),
					status: item.status as string,
				}));
			if (parts.length > 0) {
				messages.push({
					id: item.id ?? `${turnId}:file-change`,
					parts,
					role: "assistant",
					timestamp,
				});
			}
		}
	}

	return messages;
}

// ─── Provider ───────────────────────────────────────────────────────────────

export class CodexProvider implements AIProvider {
	private proc: ChildProcess | null = null;
	private shuttingDown = false;
	private emitter: AiEventEmitter | null = null;
	private nextId = 1;
	private pending = new Map<string, PendingRpc>();
	private sessions = new Map<string, CodexSession>();
	private deletedThreadIds = new Set<string>();
	private resumedThreadIds = new Set<string>();
	private pendingPermissionRequestIds = new Map<string, PendingPermission>();
	private partTextById = new Map<string, string>();

	private ensureCodexAvailable(): void {
		if (process.platform === "win32") {
			const check = spawnSync("where", ["codex"], { stdio: "ignore" });
			if (check.status !== 0) {
				const err = new Error("codex backend not available");
				(err as NodeJS.ErrnoException).code = "ENOENT";
				throw err;
			}
			return;
		}

		const check = spawnSync("which", ["codex"], { stdio: "ignore" });
		if (check.status !== 0) {
			const err = new Error("codex backend not available");
			(err as NodeJS.ErrnoException).code = "ENOENT";
			throw err;
		}
	}

	async init(): Promise<void> {
		this.ensureCodexAvailable();
		logger.debug("Starting Codex app-server...");
		this.proc = spawn("codex", ["app-server"], {
			stdio: ["pipe", "pipe", "inherit"],
			env: process.env,
		});
		if (!this.proc.stdout) {
			throw new Error("Codex app-server did not expose stdout");
		}
		const rl = createInterface({ input: this.proc.stdout });
		// TODO: associate clientId with sessions and use it in events
		rl.on("line", (line) => this.handleLine("defaultClientId", line));
		this.proc.on("error", (err) => {
			logger.error("[codex] Failed to start:", err.message);
		});
		this.proc.on("exit", (code) => {
			if (!this.shuttingDown) {
				const msg = `codex exited with code ${code}`;
				logger.error(`[codex] ${msg}`);
			}
		});

		await this.call("initialize", {
			clientInfo: { name: "shellular", version: "1.0" },
		});

		this.send({ jsonrpc: "2.0", method: "initialized", params: {} });
	}

	async destroy(): Promise<void> {
		this.shuttingDown = true;
		this.proc?.stdin?.end();
		this.proc?.kill();
		this.proc = null;
	}

	subscribe(emitter: AiEventEmitter): () => void {
		this.emitter = emitter;
		return () => {
			this.emitter = null;
		};
	}

	async createSession(
		_clientId: string,
		prompt: string,
		workspacePath: string,
	) {
		const res = (await this.call("thread/start", {
			cwd: process.cwd(),
		})) as ThreadStartResponse;
		const thread = res.thread;
		if (!thread?.id) throw new Error("thread/start missing id");
		const session = this.upsertSession({
			id: thread.id,
			title: thread.name ?? thread.preview ?? prompt ?? "Conversation",
			createdAt: normalizeDate(thread.createdAt) || Date.now(),
			updatedAt: normalizeDate(thread.createdAt) || Date.now(),
			archived: false,
			cwd: workspacePath,
		});
		this.resumedThreadIds.add(thread.id);
		return this.toSessionInfo(session);
	}

	async listSessions(_clientId: string) {
		const res = (await this.call("thread/list", {
			archived: false,
			sortKey: "updated_at",
		})) as ThreadListResponse;
		const threads = res.data ?? [];
		this.reconcileSessions(threads);
		return Array.from(this.sessions.values())
			.filter((s) => !s.archived && !this.deletedThreadIds.has(s.id))
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.map((s) => this.toSessionInfo(s));
	}

	async getSession(clientId: string, id: string) {
		let session = this.sessions.get(id);
		if (!session) {
			await this.listSessions(clientId);
			session = this.sessions.get(id);
		}
		if (!session) throw new Error(`Session ${id} not found`);
		return this.toSessionInfo(session);
	}

	async deleteSession(_clientId: string, id: string) {
		this.deletedThreadIds.add(id);
		this.sessions.delete(id);
		try {
			await this.call("thread/archive", { threadId: id });
		} catch {
			// thread/archive may fail for non-existent threads; that's fine
		}
		return true;
	}

	async getMessages(_clientId: string, sessionId: string) {
		const session = this.ensureSession(sessionId);
		const res = (await this.call("thread/read", {
			threadId: sessionId,
			includeTurns: true,
		})) as ThreadReadResponse;
		const thread = res.thread;
		if (thread) {
			session.messages = (thread.turns || []).flatMap((t: CodexTurn) =>
				turnToMessages(t),
			);
		}
		return session.messages;
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
		const session = this.ensureSession(sessionId);
		session.updatedAt = Date.now();
		(async () => {
			try {
				await this.call("turn/start", {
					threadId: sessionId,
					input: [
						...(text.trim().length > 0 ? [{ type: "text", text }] : []),
						...files,
					],
					...(model
						? {
								model:
									model.providerID === "codex"
										? model.modelID
										: `${model.providerID}/${model.modelID}`,
							}
						: {}),
					...(agent ? { agent } : {}),
					...(codexOptions?.reasoningEffort
						? { effort: codexOptions.reasoningEffort }
						: {}),
				});
			} catch (err: unknown) {
				this.emitter?.(clientId, {
					type: "prompt_error",
					properties: { sessionId, error: getErrorMessage(err) },
				});
			}
		})();
		return { ack: true };
	}

	async abort(
		_clientId: string,
		sessionId: string,
	): Promise<Record<string, never>> {
		await this.call("turn/interrupt", { threadId: sessionId });
		return {};
	}

	async agents(_clientId: string) {
		return [];
	}

	async providers(_clientId: string): Promise<ProviderInfo> {
		const res = (await this.call("model/list", {})) as ModelListResponse;
		const items: CodexModelItem[] = res.data ?? [];
		const models = Object.fromEntries(
			items.map((i) => [
				i.id,
				{
					id: i.id,
					name: i.displayName ?? i.name ?? i.id,
					provider: "codex",
					description: i.description,
				},
			]),
		);
		return {
			providers: [{ id: "codex", name: "Codex", models }],
			default: {
				codex: items.find((i) => i.isDefault)?.id ?? items[0]?.id,
			},
		};
	}

	async setAuth(): Promise<Record<string, never>> {
		throw new Error("Codex auth not supported");
	}
	async command(): Promise<{ result: unknown }> {
		throw new Error("Codex command not supported");
	}
	async revert(): Promise<Record<string, never>> {
		throw new Error("Codex revert not supported");
	}
	async unrevert(): Promise<Record<string, never>> {
		throw new Error("Codex unrevert not supported");
	}
	async share(): Promise<{ share: ShareInfo }> {
		return { share: { url: null } };
	}

	async permissionReply(
		_sessionId: string,
		permissionId: string,
		response: "once" | "always" | "reject",
	): Promise<Record<string, never>> {
		const pending = this.pendingPermissionRequestIds.get(permissionId);
		if (!pending) throw new Error("Permission not pending");
		const decision =
			response === "reject"
				? "decline"
				: response === "always"
					? "acceptForSession"
					: "accept";
		this.send({ jsonrpc: "2.0", id: pending.requestId, result: { decision } });
		this.pendingPermissionRequestIds.delete(permissionId);
		return {};
	}

	// ─── Transport ─────────────────────────────────────────────────────────────

	private send(req: JsonRpcOutbound): void {
		if (this.proc?.stdin?.writable)
			this.proc.stdin.write(`${JSON.stringify(req)}\n`);
	}

	private call(method: string, params: unknown): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const id = this.nextId++;
			const key = String(id);
			this.pending.set(key, { resolve, reject });
			this.send({ jsonrpc: "2.0", id, method, params });
			setTimeout(() => {
				if (this.pending.delete(key))
					reject(new Error(`Codex RPC timeout: ${method}`));
			}, 30000);
		});
	}

	// ─── Incoming message handling ─────────────────────────────────────────────

	private handleLine(clientId: string, line: string): void {
		let msg: JsonRpcInboundMessage;
		try {
			msg = JSON.parse(line) as JsonRpcInboundMessage;
		} catch {
			return;
		}
		if (!msg) return;

		if (msg.method) {
			if (msg.id != null) {
				this.handleServerRequest(
					clientId,
					msg.method,
					msg.id,
					msg.params ?? {},
				);
			} else {
				this.handleNotification(clientId, msg.method, msg.params ?? {});
			}
		} else if (msg.id != null) {
			const pending = this.pending.get(String(msg.id));
			if (pending) {
				this.pending.delete(String(msg.id));
				if (msg.error)
					pending.reject(new Error(msg.error.message ?? "Codex RPC error"));
				else pending.resolve(msg.result);
			}
		}
	}

	private handleServerRequest(
		clientId: string,
		method: string,
		requestId: number | string,
		params: unknown,
	): void {
		if (method.endsWith("requestApproval")) {
			const id = String(requestId);
			const p = params as Record<string, unknown>;
			const sessionId = typeof p.threadId === "string" ? p.threadId : "";
			this.pendingPermissionRequestIds.set(id, {
				sessionId,
				requestId,
				method,
			});
			this.emitter?.(clientId, {
				type: "permission.updated",
				properties: {
					id,
					sessionId: sessionId,
					type: method,
					title: typeof p.reason === "string" ? p.reason : method,
					metadata: p,
				},
			});
		} else {
			this.send({
				jsonrpc: "2.0",
				id: requestId,
				error: { code: -32601, message: "Unsupported" },
			});
		}
	}

	private handleNotification(
		clientId: string,
		method: string,
		params: unknown,
	): void {
		const p = params as Record<string, unknown>;

		switch (method) {
			case "turn/started": {
				const tp = params as unknown as TurnStartedParams;
				const sessionId =
					typeof tp.threadId === "string"
						? tp.threadId
						: typeof p.threadId === "string"
							? p.threadId
							: undefined;
				if (sessionId) {
					const session = this.upsertSession({
						id: sessionId,
						updatedAt: Date.now(),
					});
					session.activeTurnId = tp.turn.id;
				}
				break;
			}
			case "turn/completed": {
				const tp = params as unknown as TurnCompletedParams;
				const sessionId =
					typeof tp.threadId === "string"
						? tp.threadId
						: typeof p.threadId === "string"
							? p.threadId
							: undefined;
				if (sessionId) {
					const session = this.upsertSession({
						id: sessionId,
						updatedAt: Date.now(),
					});
					session.activeTurnId = undefined;
				}
				if (tp.turn?.error) {
					this.emitter?.(clientId, {
						type: "prompt_error",
						properties: {
							sessionId,
							error: tp.turn.error.message ?? "Unknown error",
						},
					});
				}
				break;
			}
			case "turn/status/changed": {
				// Params: { threadId, status: { type, activeFlags? } }
				const sp = params as unknown as TurnStatusParams;
				if (sp.threadId && sp.status) {
					this.emitter?.(clientId, {
						type: "session.status",
						properties: {
							sessionId: sp.threadId,
							status: sp.status,
						},
					});
				}
				break;
			}
			case "item/agentMessage/delta":
			case "item/reasoning/textDelta": {
				const delta = params as unknown as
					| AgentMessageDeltaParams
					| ReasoningTextDeltaParams;
				const sessionId = typeof p.threadId === "string" ? p.threadId : "";
				const type = method.includes("reasoning") ? "reasoning" : "text";
				const partKey = `${sessionId}:${type}:${delta.itemId ?? "main"}`;
				const nextText = joinStreamingText(
					this.partTextById.get(partKey) ?? "",
					delta.text ?? "",
				);
				this.partTextById.set(partKey, nextText);

				const normalized = normalizeAiEvent({
					type: "message.part.updated",
					properties: {
						part: { id: partKey, sessionId: sessionId, type, text: nextText },
						message: { sessionId: sessionId, role: "assistant" },
					},
				});

				this.emitter?.(clientId, normalized);
				break;
			}
			case "thread/started":
			case "thread/unarchived": {
				const thread =
					typeof p.thread === "object" && p.thread !== null
						? (p.thread as Record<string, unknown>)
						: undefined;
				const sessionId =
					(typeof p.threadId === "string" ? p.threadId : undefined) ??
					(typeof thread?.id === "string" ? thread.id : undefined);
				if (sessionId) {
					this.upsertSession({
						id: sessionId,
						title:
							typeof thread?.name === "string"
								? thread.name
								: typeof thread?.preview === "string"
									? thread.preview
									: undefined,
						createdAt: normalizeDate(thread?.createdAt) ?? Date.now(),
						updatedAt: Date.now(),
					});
				}
				break;
			}
			case "thread/archived":
			case "thread/closed": {
				const sessionId =
					typeof p.threadId === "string" ? p.threadId : undefined;
				if (sessionId) {
					this.upsertSession({
						id: sessionId,
						archived: method === "thread/archived" ? true : undefined,
						updatedAt: Date.now(),
					});
				}
				break;
			}
			default: {
				// Forward all other notifications as normalized events
				const normalized = normalizeAiEvent({
					type: method,
					properties: p,
				});
				this.emitter?.(clientId, normalized);
				break;
			}
		}
	}

	private upsertSession(
		data: Partial<CodexSession> & { id: string },
	): CodexSession {
		let s = this.sessions.get(data.id);
		if (!s) {
			s = {
				id: data.id,
				title: (data.title as string) || "Conversation",
				createdAt: (data.createdAt as number) || Date.now(),
				updatedAt: (data.updatedAt as number) || Date.now(),
				messages: [],
			};
			this.sessions.set(data.id, s);
		} else {
			if (data.title !== undefined) s.title = data.title;
			if (data.createdAt !== undefined) s.createdAt = data.createdAt;
			if (data.updatedAt !== undefined) s.updatedAt = data.updatedAt;
			if (data.archived !== undefined) s.archived = data.archived;
			if (data.cwd !== undefined) s.cwd = data.cwd;
		}
		return s;
	}

	private ensureSession(id: string): CodexSession {
		const s = this.sessions.get(id);
		if (!s) throw new Error(`No local session ${id}`);
		return s;
	}

	private reconcileSessions(threads: ThreadListEntry[]): void {
		for (const t of threads) {
			const createdAt = normalizeDate(t.createdAt ?? t.created_at);
			const updatedAt = normalizeDate(t.updatedAt ?? t.updated_at);
			this.upsertSession({
				id: t.id,
				title: t.name ?? t.title ?? t.preview,
				createdAt,
				updatedAt,
				archived: t.archived,
				cwd: t.cwd,
			});
		}
	}

	private toSessionInfo(s: CodexSession): AiSession {
		return {
			id: s.id,
			title: s.title || "Conversation",
			createdAt: s.createdAt,
			updatedAt: s.updatedAt,
			workspacePath: s.cwd || undefined,
		};
	}
}

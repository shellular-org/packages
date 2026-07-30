import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";
import {
	AcpForkSessionResponseSchema as zForkSessionResponse,
	AcpInitializeResponseSchema as zInitializeResponse,
	AcpListSessionsResponseSchema as zListSessionsResponse,
	AcpLoadSessionResponseSchema as zLoadSessionResponse,
	AcpNewSessionResponseSchema as zNewSessionResponse,
	AcpResumeSessionResponseSchema as zResumeSessionResponse,
	AcpSetConfigOptionResponseSchema as zSetSessionConfigOptionResponse,
} from "@shellular/protocol";
import { config } from "@/config";
import { logger } from "@/logger";
import { commandExists } from "@/utils";
import {
	AcpClient,
	type ElicitationListener,
	type PermissionListener,
} from "./client";
import { AgentUnavailableError, UnsupportedCapabilityError } from "./errors";
import {
	AcpTranscript,
	type AcpTranscriptOptions,
	acpSessionToAiSession,
	newAiSessionFromResponse,
	promptEndEvent,
} from "./events";
import type {
	AgentConnectionState,
	AgentDescriptor,
	AgentInfo,
	LoadSessionResult,
	PromptCallbacks,
	PromptResult,
	StoredSession,
} from "./types";

/**
 * Quote a command/argument for safe use with `cmd.exe` (Windows `shell: true`).
 * Only quotes when needed (contains whitespace or shell metacharacters) and
 * escapes embedded double quotes by doubling them.
 */
function quoteForCmd(value: string): string {
	if (value === "") {
		return '""';
	}

	if (!/[\s"&|<>^()%!]/.test(value)) {
		return value;
	}

	return `"${value.replace(/"/g, '""')}"`;
}

/** Configuration for spawning an ACP agent subprocess. */
export interface AgentProcessConfig {
	name: string;
	agentExecutable?: string;
	command: string;
	/** Command-line arguments passed to the executable. */
	args?: string[];
	/** Additional environment variables for the subprocess. */
	env?: Record<string, string>;
	/** Working directory for the subprocess. */
	cwd?: string;
}

/** A running agent subprocess together with its ACP communication stream. */
export interface SpawnedAgent {
	/** The config that was used to spawn this agent. */
	processConfig: AgentProcessConfig;
	/** The underlying Node.js child process. */
	process: ChildProcessWithoutNullStreams;
	/** The ndjson stream used to exchange ACP messages with the agent. */
	stream: acp.Stream;
}

/**
 * Runtime wrapper for one ACP agent process.
 *
 * This is the protocol boundary: callers deal with stable Shellular-facing
 * methods, while this class owns JSON-RPC, ACP capability checks, subprocess
 * state, and in-memory transcript reconstruction.
 */
export class ACP {
	readonly descriptor: AgentDescriptor;
	private readonly client: AcpClient;
	private spawnedAgent: SpawnedAgent | null = null;
	private connection: acp.ClientConnection | null = null;
	private initResult: acp.InitializeResponse | null = null;
	private transcripts = new Map<string, AcpTranscript>();
	private sessions = new Map<string, StoredSession>();
	private loadingSessions = new Map<string, Promise<void>>();
	private activePromptSessionIds = new Set<string>();
	private stderrBuffer = "";
	private state: AgentConnectionState = "unavailable";
	private stateError: string | undefined;

	constructor(descriptor: AgentDescriptor) {
		this.descriptor = descriptor;
		this.client = new AcpClient();
	}

	get id() {
		return this.descriptor.id;
	}

	get capabilities() {
		return this.initResult?.agentCapabilities;
	}

	getState(): AgentConnectionState {
		return this.state;
	}

	canReuse(): boolean {
		return this.state !== "exited" && this.state !== "failed";
	}

	getInfo(): AgentInfo {
		return {
			state: this.state,
			id: this.descriptor.id,
			error: this.stateError,
			name: this.descriptor.name,
			title: this.descriptor.title,
			capabilities: this.capabilities,
			available: this.isCommandAvailable(),
			description: this.descriptor.description,
			note: this.descriptor.note,
			version: this.descriptor.version ?? this.initResult?.agentInfo?.version,
		};
	}

	onPermission(clientId: string, listener: PermissionListener) {
		return this.client.onPermission(clientId, listener);
	}

	onElicitation(clientId: string, listener: ElicitationListener) {
		return this.client.onElicitation(clientId, listener);
	}

	onElicitationComplete(
		listener: (params: acp.CompleteElicitationNotification) => void,
	) {
		return this.client.onElicitationComplete(listener);
	}

	replyElicitation(
		elicitationId: string,
		response: acp.CreateElicitationResponse,
	) {
		return this.client.replyElicitation(elicitationId, response);
	}

	/**
	 * Latest slash commands the agent advertised for a session. Agents may send
	 * `available_commands_update` after the session/load response, so this is
	 * tracked continuously rather than scraped from a load's updates.
	 */
	getAvailableCommands(sessionId: string) {
		return this.client.getAvailableCommands(sessionId);
	}

	/**
	 * Subscribe to every session/update this runtime receives, across all of its
	 * sessions. Runtime-wide by necessity: callers register before any session
	 * exists and must cover sessions opened later by new/load/resume alike.
	 * Per-session callers want `addSessionUpdateListener` instead.
	 */
	onSessionUpdate(
		listener: (notification: acp.SessionNotification) => void | Promise<void>,
	) {
		return this.client.onSessionUpdate(listener);
	}

	async init(): Promise<acp.InitializeResponse> {
		if (this.state === "ready" && this.initResult) {
			return this.initResult;
		}

		if (!this.isCommandAvailable()) {
			this.state = "unavailable";
			throw new AgentUnavailableError(this.id, "spawn command was not found");
		}

		this.state = "starting";
		this.stateError = undefined;

		try {
			this.spawnedAgent = this.spawnAgent();

			// `session/update` goes first only to keep the hottest inbound path
			// short: the SDK walks handlers sequentially with an `await` per
			// entry, so every handler ahead of it delays each notification by
			// another microtask tick. This is a performance nicety, not a
			// correctness requirement — `AcpClient.observeStream` counts
			// notifications at the transport, so replay stays complete no matter
			// how this chain is ordered or how many handlers are added.
			this.connection = acp
				.client({ name: config.NAME })
				.onNotification(acp.methods.client.session.update, (ctx) =>
					this.client.sessionUpdate(ctx.params),
				)
				.onRequest(acp.methods.client.session.requestPermission, (ctx) =>
					this.client.requestPermission(ctx.params),
				)
				.onRequest(acp.methods.client.elicitation.create, (ctx) =>
					this.client.requestElicitation(ctx.params),
				)
				.onNotification(acp.methods.client.elicitation.complete, (ctx) =>
					this.client.completeElicitation(ctx.params),
				)
				.connect(this.spawnedAgent.stream);

			const rawInit = await this.agent().request(acp.methods.agent.initialize, {
				protocolVersion: acp.PROTOCOL_VERSION,
				clientCapabilities: {
					// File/terminal RPCs are intentionally off for the first ACP pass.
					// Agents can still use their own tools; Shellular just does not yet
					// expose host filesystem methods over ACP.
					fs: {
						readTextFile: false,
						writeTextFile: false,
					},
					// Structured user-input requests (agent question forms, MCP server
					// elicitations, sign-in URLs). UNSTABLE in ACP v1; the app renders
					// forms from the requested JSON schema and opens url-mode links.
					elicitation: {
						form: {},
						url: {},
					},
				},
				clientInfo: {
					name: config.NAME,
					version: config.VERSION,
				},
			});
			this.initResult = this.safeParse(
				"initialize",
				zInitializeResponse,
				rawInit,
			);

			this.state = "ready";
			return this.initResult;
		} catch (err) {
			this.state = "failed";
			this.stateError = this.errorMessage(err);
			this.destroy();
			throw err;
		}
	}

	static spawnAgentProcess(config: AgentProcessConfig): SpawnedAgent {
		if (config.agentExecutable && !commandExists(config.agentExecutable)) {
			throw new AgentUnavailableError(
				config.name,
				"agent executable was not found",
			);
		}

		// On Windows, Node.js refuses to spawn .bat/.cmd files directly since the
		// fix for CVE-2024-27980 (spawn EINVAL). Commands like `npx.cmd`, and the
		// shims for `opencode`, `cursor-agent`, `hermes`, etc., are .cmd files, so
		// they must be run through a shell. `shell: true` makes Node invoke cmd.exe,
		// which can resolve and execute these script shims.
		const useShell = process.platform === "win32";
		const args = config.args ?? [];
		const agentProcess = spawn(
			useShell ? quoteForCmd(config.command) : config.command,
			// With shell:true on Windows, args are concatenated into a command line,
			// so anything containing spaces/special chars must be quoted.
			useShell ? args.map(quoteForCmd) : args,
			{
				cwd: config.cwd,
				env: { ...process.env, ...(config.env ?? {}) },
				stdio: ["pipe", "pipe", "pipe"],
				shell: useShell,
			},
		);

		const input = Writable.toWeb(agentProcess.stdin);
		const output = Readable.toWeb(
			agentProcess.stdout,
		) as ReadableStream<Uint8Array>;

		return {
			processConfig: config,
			process: agentProcess,
			stream: acp.ndJsonStream(input, output),
		};
	}

	async listSessions(params: acp.ListSessionsRequest = {}) {
		await this.ensureReady();
		if (!this.capabilities?.sessionCapabilities?.list) {
			throw new UnsupportedCapabilityError(this.id, "session/list");
		}
		if (this.hasActivePrompt()) {
			return this.cachedSessionInfos(params);
		}

		const all: acp.SessionInfo[] = [];
		let cursor = params.cursor;
		do {
			const response = await this.listSessionPage({ ...params, cursor });
			all.push(...response.sessions);
			cursor = response.nextCursor ?? undefined;
		} while (cursor);

		return all;
	}

	async listSessionPage(
		params: acp.ListSessionsRequest = {},
	): Promise<acp.ListSessionsResponse> {
		await this.ensureReady();
		if (!this.capabilities?.sessionCapabilities?.list) {
			throw new UnsupportedCapabilityError(this.id, "session/list");
		}
		if (this.hasActivePrompt()) {
			return {
				sessions: params.cursor ? [] : this.cachedSessionInfos(params),
				nextCursor: undefined,
			};
		}

		const raw = await this.agent().request(
			acp.methods.agent.session.list,
			params,
		);
		const response = this.safeParse("session/list", zListSessionsResponse, raw);
		for (const session of response.sessions) {
			const normalized = acpSessionToAiSession(session);
			const existing = this.sessions.get(session.sessionId);
			this.sessions.set(session.sessionId, {
				session: normalized,
				messages: existing?.messages ?? [],
			});
		}

		return response;
	}

	async listAiSessions(cwd?: string) {
		if (this.hasActivePrompt()) {
			return this.cachedAiSessions(cwd);
		}
		const sessions = await this.listSessions(
			cwd ? { cwd: path.resolve(cwd) } : {},
		);
		return sessions.map(acpSessionToAiSession);
	}

	async listAiSessionsPage(cwd?: string, cursor?: string) {
		if (this.hasActivePrompt()) {
			return {
				sessions: cursor ? [] : this.cachedAiSessions(cwd),
				nextCursor: undefined,
			};
		}
		const response = await this.listSessionPage({
			...(cwd ? { cwd: path.resolve(cwd) } : {}),
			...(cursor ? { cursor } : {}),
		});
		return {
			sessions: response.sessions.map(acpSessionToAiSession),
			nextCursor: response.nextCursor ?? undefined,
		};
	}

	async createSession(
		cwd: string,
		options: Partial<Omit<acp.NewSessionRequest, "cwd">> = {},
	) {
		await this.ensureReady();
		const absoluteCwd = path.resolve(cwd);
		const raw = await this.agent().request(acp.methods.agent.session.new, {
			...options,
			cwd: absoluteCwd,
			mcpServers: options.mcpServers ?? [],
		});
		const response = this.safeParse("session/new", zNewSessionResponse, raw);
		const session = newAiSessionFromResponse(response, absoluteCwd);
		this.sessions.set(response.sessionId, {
			session,
			messages: [],
		});
		this.transcripts.set(
			response.sessionId,
			this.createTranscript(response.sessionId),
		);
		// No session/update listener here: session/new creates an empty session,
		// so there is no replay or turn to capture. `available_commands_update` is
		// an async readiness signal with no ordering guarantee against this
		// response, so it is read from the connection's continuous tracking (and
		// delivered later as a status event if it has not arrived yet).
		return {
			response,
			session,
			availableCommands: this.getAvailableCommands(response.sessionId),
		};
	}

	async resumeSession(params: acp.ResumeSessionRequest) {
		await this.ensureReady();
		if (!this.capabilities?.sessionCapabilities?.resume) {
			throw new UnsupportedCapabilityError(this.id, "session/resume");
		}

		const raw = await this.agent().request(acp.methods.agent.session.resume, {
			...params,
			cwd: path.resolve(params.cwd),
			mcpServers: params.mcpServers ?? [],
		});
		const response = this.safeParse(
			"session/resume",
			zResumeSessionResponse,
			raw,
		);
		const session = newAiSessionFromResponse(
			response,
			path.resolve(params.cwd),
			params.sessionId,
		);
		this.sessions.set(params.sessionId, {
			session,
			messages: this.getMessages(params.sessionId),
		});
		this.getTranscript(params.sessionId);
		return { response, session };
	}

	async forkSession(params: acp.ForkSessionRequest) {
		await this.ensureReady();
		if (!this.capabilities?.sessionCapabilities?.fork) {
			throw new UnsupportedCapabilityError(this.id, "session/fork");
		}

		const raw = await this.agent().request(acp.methods.agent.session.fork, {
			...params,
			cwd: path.resolve(params.cwd),
			mcpServers: params.mcpServers ?? [],
		});
		const response = this.safeParse("session/fork", zForkSessionResponse, raw);
		const session = newAiSessionFromResponse(
			response,
			path.resolve(params.cwd),
		);
		if (session.id) {
			this.sessions.set(session.id, { session, messages: [] });
			this.transcripts.set(session.id, this.createTranscript(session.id));
		}
		return { response, session };
	}

	async closeSession(params: acp.CloseSessionRequest) {
		await this.ensureReady();
		if (!this.capabilities?.sessionCapabilities?.close) {
			throw new UnsupportedCapabilityError(this.id, "session/close");
		}

		const response = await this.agent().request(
			acp.methods.agent.session.close,
			params,
		);
		this.sessions.delete(params.sessionId);
		this.transcripts.delete(params.sessionId);
		this.client.cancelSessionPermissions(params.sessionId);
		this.client.cancelSessionElicitations(params.sessionId);
		return response;
	}

	async loadSession(
		params: acp.LoadSessionRequest,
		clientId?: string,
	): Promise<LoadSessionResult> {
		await this.ensureReady();
		if (!this.capabilities?.loadSession) {
			throw new UnsupportedCapabilityError(this.id, "session/load");
		}
		if (this.hasActivePrompt()) {
			return this.cachedLoadSession(params, clientId);
		}

		const sessionId = params.sessionId;
		const transcript = this.createTranscript(sessionId);
		const updates: acp.SessionNotification[] = [];
		let finishLoading: () => void = () => {
			logger.warn(
				"finishLoading called before initialization, this should not happen",
			);
		};
		const loading = new Promise<void>((resolve) => {
			finishLoading = () => {
				if (this.loadingSessions.get(sessionId) === loading) {
					this.loadingSessions.delete(sessionId);
				}
				resolve();
			};
		});
		this.loadingSessions.set(sessionId, loading);
		const listener = (notification: acp.SessionNotification) => {
			// session/load replays history as session/update notifications before
			// resolving, so collecting here gives callers a usable transcript.
			updates.push(notification);
			transcript.apply(notification);
		};
		this.client.addSessionUpdateListener(sessionId, listener);

		const loadStartedAt = Date.now();
		try {
			const raw = await this.agent().request(acp.methods.agent.session.load, {
				...params,
				cwd: path.resolve(params.cwd),
				mcpServers: params.mcpServers ?? [],
			});
			// Per ACP, the agent replays the whole conversation as session/update
			// notifications and only then responds to session/load, so the last
			// chunk is always sent before this resolves. The SDK, however,
			// dispatches notifications through an awaited handler chain while
			// resolving responses synchronously — so a notification already
			// received can still be mid-dispatch here. Wait for the dispatcher
			// to go idle before reading the transcript, or the tail of the
			// replay is lost.
			await this.client.settled();
			const response = this.safeParse(
				"session/load",
				zLoadSessionResponse,
				raw,
			);
			this.transcripts.set(sessionId, transcript);
			const messages = transcript.getMessages();
			logger.debug(
				`ACP ${this.id}: session/load ${sessionId} replayed ${updates.length} updates -> ${messages.length} messages in ${Date.now() - loadStartedAt}ms (~${JSON.stringify(messages).length} bytes)`,
			);
			const existing = this.sessions.get(sessionId);
			this.sessions.set(sessionId, {
				session: existing?.session
					? {
							...existing.session,
							configOptions:
								response.configOptions ?? existing.session.configOptions,
						}
					: newAiSessionFromResponse(
							{ sessionId, configOptions: response.configOptions },
							path.resolve(params.cwd),
						),
				messages,
			});
			return { response, updates, messages };
		} finally {
			// When session is loaded again, this is required to show the permission prompt again.
			this.client.requestPendingPermission(sessionId, clientId);
			this.client.requestPendingElicitation(sessionId, clientId);
			this.client.removeSessionUpdateListener(sessionId, listener);
			finishLoading();
		}
	}

	async prompt(
		params: acp.PromptRequest,
		callbacks: PromptCallbacks = {},
		clientId?: string,
	): Promise<PromptResult> {
		await this.ensureReady();
		const loading = this.loadingSessions.get(params.sessionId);
		if (loading) {
			await loading;
		}

		const transcript = this.getTranscript(params.sessionId);
		let permissionRequested = false;
		const updateTasks = new Set<Promise<void>>();
		this.activePromptSessionIds.add(params.sessionId);
		transcript.beginTurn(params.prompt);
		const listener = async (notification: acp.SessionNotification) => {
			if (!permissionRequested) {
				permissionRequested = this.client.requestPendingPermission(
					params.sessionId,
					clientId,
				);
			}
			if (
				permissionRequested &&
				this.client.hasPendingPermission(params.sessionId)
			) {
				return;
			}

			const updateTask = (async () => {
				const loading = this.loadingSessions.get(params.sessionId);
				if (loading) {
					await loading;
				}

				callbacks.onUpdate?.(notification);
				for (const event of transcript.apply(notification)) {
					callbacks.onEvent?.(event);
				}
			})();
			updateTasks.add(updateTask);
			void updateTask.finally(() => {
				updateTasks.delete(updateTask);
			});
			await updateTask;
		};
		this.client.addSessionUpdateListener(params.sessionId, listener);

		try {
			const response = await this.agent().request(
				acp.methods.agent.session.prompt,
				params,
			);
			if (updateTasks.size > 0) {
				await Promise.all(updateTasks);
			}
			transcript.endTurn(response.stopReason);
			callbacks.onEvent?.(promptEndEvent(params.sessionId, response));
			const messages = transcript.getMessages();
			const existing = this.sessions.get(params.sessionId);
			if (existing) {
				this.sessions.set(params.sessionId, {
					session: { ...existing.session, updatedAt: Date.now() },
					messages,
				});
			}
			return { response, messages };
		} catch (err) {
			transcript.endTurn();
			callbacks.onEvent?.({
				type: "error",
				properties: {
					sessionId: params.sessionId,
					error: this.errorMessage(err),
				},
			});
			throw err;
		} finally {
			this.client.removeSessionUpdateListener(params.sessionId, listener);
			this.activePromptSessionIds.delete(params.sessionId);
		}
	}

	async interrupt(params: acp.CancelNotification) {
		await this.ensureReady();
		this.client.cancelSessionPermissions(params.sessionId);
		this.client.cancelSessionElicitations(params.sessionId);
		return this.agent().notify(acp.methods.agent.session.cancel, params);
	}

	async setSessionConfigOption(params: acp.SetSessionConfigOptionRequest) {
		await this.ensureReady();
		const raw = await this.agent().request(
			acp.methods.agent.session.setConfigOption,
			params,
		);
		const response = this.safeParse(
			"session/set_config_option",
			zSetSessionConfigOptionResponse,
			raw,
		);
		const existing = this.sessions.get(params.sessionId);
		if (existing) {
			this.sessions.set(params.sessionId, {
				...existing,
				session: {
					...existing.session,
					configOptions: response.configOptions,
					updatedAt: Date.now(),
				},
			});
		}
		return response;
	}

	async setSessionMode(params: acp.SetSessionModeRequest) {
		await this.ensureReady();
		return this.agent().request(acp.methods.agent.session.setMode, params);
	}

	requestPendingPermissions(clientId: string) {
		return this.client.requestPendingPermissions(clientId);
	}

	replyPermission(permissionId: string, optionId: string) {
		return this.client.replyPermission(permissionId, optionId);
	}

	getMessages(sessionId: string) {
		return (
			this.transcripts.get(sessionId)?.getMessages() ??
			this.sessions.get(sessionId)?.messages ??
			[]
		);
	}

	getSession(sessionId: string) {
		return this.sessions.get(sessionId)?.session ?? null;
	}

	snapshotSession(
		params: acp.LoadSessionRequest,
		clientId?: string,
	): LoadSessionResult {
		return this.cachedLoadSession(params, clientId);
	}

	destroy() {
		this.connection?.close();
		if (this.spawnedAgent) {
			this.spawnedAgent.process.kill();
			this.spawnedAgent = null;
		}
		this.connection = null;
		this.initResult = null;
		if (this.state !== "failed") {
			this.state = "exited";
		}
	}

	protected getTranscript(sessionId: string): AcpTranscript {
		let transcript = this.transcripts.get(sessionId);
		if (!transcript) {
			transcript = this.createTranscript(sessionId);
			this.transcripts.set(sessionId, transcript);
		}
		return transcript;
	}

	protected createTranscript(sessionId: string): AcpTranscript {
		return new AcpTranscript(sessionId, this.transcriptOptions());
	}

	protected transcriptOptions(): AcpTranscriptOptions {
		return {};
	}

	protected setSessionStore(sessionId: string, stored: StoredSession) {
		this.sessions.set(sessionId, stored);
	}

	hasActivePrompt() {
		return this.activePromptSessionIds.size > 0;
	}

	private cachedLoadSession(
		params: acp.LoadSessionRequest,
		clientId?: string,
	): LoadSessionResult {
		const sessionId = params.sessionId;
		const existing = this.sessions.get(sessionId);
		const session =
			existing?.session ??
			newAiSessionFromResponse(
				{
					sessionId,
				},
				path.resolve(params.cwd),
				sessionId,
			);
		const messages = this.getMessages(sessionId);
		if (!existing) {
			this.sessions.set(sessionId, { session, messages });
		}
		this.client.requestPendingPermission(sessionId, clientId);
		return {
			response: {
				configOptions: session.configOptions ?? [],
			},
			updates: [],
			messages,
		};
	}

	private cachedAiSessions(cwd?: string) {
		return this.cachedSessionInfos(cwd ? { cwd: path.resolve(cwd) } : {}).map(
			acpSessionToAiSession,
		);
	}

	private cachedSessionInfos(params: acp.ListSessionsRequest = {}) {
		const cwd = params.cwd ? path.resolve(params.cwd) : undefined;
		return [...this.sessions.values()]
			.map(({ session }) => this.sessionInfoFromStoredSession(session))
			.filter((session): session is acp.SessionInfo => Boolean(session))
			.filter((session) => !cwd || path.resolve(session.cwd) === cwd)
			.sort((a, b) => timestampMs(b.updatedAt) - timestampMs(a.updatedAt));
	}

	private sessionInfoFromStoredSession(
		session: StoredSession["session"],
	): acp.SessionInfo | null {
		if (!session.id) return null;
		const cwd = session.workspacePath
			? path.resolve(session.workspacePath)
			: "";
		if (!cwd) return null;
		return {
			sessionId: session.id,
			cwd,
			title: session.title,
			updatedAt: session.updatedAt
				? new Date(session.updatedAt).toISOString()
				: undefined,
		};
	}

	private isCommandAvailable() {
		return commandExists(
			this.descriptor.agentExecutable ?? this.descriptor.spawn.command,
		);
	}

	private async ensureReady() {
		if (this.state !== "ready") {
			await this.init();
		}
	}

	/** Context for calling agent-side ACP methods on the live connection. */
	private agent(): acp.ClientContext {
		if (!this.connection) {
			throw new AgentUnavailableError(this.id, "connection is not initialized");
		}
		return this.connection.agent;
	}

	private errorMessage(err: unknown) {
		if (err instanceof Error) return err.message;
		if (typeof err === "string") return err;
		return String(err);
	}

	/**
	 * Validate an ACP response against its Zod schema. Falls back to the raw
	 * value on parse failure (with a warning) so agents with minor schema
	 * deviations don't completely break the flow.
	 */
	private safeParse<T>(
		method: string,
		schema: { safeParse: (data: unknown) => { success: boolean; data?: T } },
		data: unknown,
	): T {
		const result = schema.safeParse(data);
		if (!result.success) {
			logger.warn(
				`ACP ${this.id}: ${method} response failed schema validation, using raw`,
			);
			return data as T;
		}
		return result.data as T;
	}

	protected spawnAgent() {
		if (this.spawnedAgent) {
			throw new Error("Agent process already spawned");
		}

		const spawnedAgent = ACP.spawnAgentProcess({
			name: this.id,
			agentExecutable: this.descriptor.agentExecutable,
			command: this.descriptor.spawn.command,
			args: this.descriptor.spawn.args,
			env: this.descriptor.spawn.env,
			cwd: this.descriptor.spawn.cwd,
		});

		const child = spawnedAgent.process;
		child.stderr.on("data", (chunk: Buffer) => {
			this.stderrBuffer += chunk.toString("utf8");
			if (this.stderrBuffer.length > 20_000) {
				this.stderrBuffer = this.stderrBuffer.slice(-20_000);
			}
		});
		child.on("error", (err) => {
			this.state = "failed";
			this.stateError = err.message;
			logger.warn(`ACP agent ${this.id} process error`, err);
		});
		child.on("exit", (code, signal) => {
			if (this.state !== "failed") {
				this.state = "exited";
				this.stateError =
					code === 0
						? undefined
						: `Agent exited with code ${code ?? "null"} signal ${signal ?? "null"}`;
			}
		});

		return {
			...spawnedAgent,
			stream: this.client.observeStream(spawnedAgent.stream),
		};
	}
}

function timestampMs(value: string | null | undefined) {
	if (!value) return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

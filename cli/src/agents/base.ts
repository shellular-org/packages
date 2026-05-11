import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";
import {
	zForkSessionResponse,
	zInitializeResponse,
	zListSessionsResponse,
	zLoadSessionResponse,
	zNewSessionResponse,
	zResumeSessionResponse,
	zSetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk/dist/schema/zod.gen.js";
import { config } from "@/config";
import { logger } from "@/logger";
import { commandExists } from "@/utils";
import { AcpClient, type PermissionListener } from "./client";
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
	private connection: acp.ClientSideConnection | null = null;
	private initResult: acp.InitializeResponse | null = null;
	private transcripts = new Map<string, AcpTranscript>();
	private sessions = new Map<string, StoredSession>();
	private loadingSessions = new Map<string, Promise<void>>();
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

	getInfo(): AgentInfo {
		return {
			id: this.descriptor.id,
			backend: this.descriptor.id,
			name: this.descriptor.name,
			title: this.descriptor.title,
			version: this.descriptor.version ?? this.initResult?.agentInfo?.version,
			description: this.descriptor.description,
			icon: this.descriptor.icon,
			source: this.descriptor.source,
			state: this.state,
			available: this.isCommandAvailable(),
			error: this.stateError,
			capabilities: this.capabilities,
		};
	}

	onPermission(clientId: string, listener: PermissionListener) {
		return this.client.onPermission(clientId, listener);
	}

	onSessionUpdate(
		listener: (notification: acp.SessionNotification) => void | Promise<void>,
	) {
		this.client.addAnySessionUpdateListener(listener);
		return () => this.client.removeAnySessionUpdateListener(listener);
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
			this.spawnedAgent = ACP.spawnAgentProcess({
				name: this.id,
				agentExecutable: this.descriptor.agentExecutable,
				command: this.descriptor.spawn.command,
				args: this.descriptor.spawn.args,
				env: this.descriptor.spawn.env,
				cwd: this.descriptor.spawn.cwd,
			});
			this.attachProcessListeners();

			this.connection = new acp.ClientSideConnection(
				() => this.client,
				this.spawnedAgent.stream,
			);

			const rawInit = await this.connection.initialize({
				protocolVersion: acp.PROTOCOL_VERSION,
				clientCapabilities: {
					// File/terminal RPCs are intentionally off for the first ACP pass.
					// Agents can still use their own tools; Shellular just does not yet
					// expose host filesystem methods over ACP.
					fs: {
						readTextFile: false,
						writeTextFile: false,
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

		const agentProcess = spawn(config.command, config.args ?? [], {
			cwd: config.cwd,
			env: { ...process.env, ...(config.env ?? {}) },
			stdio: ["pipe", "pipe", "pipe"],
		});

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

		const raw = await this.requireConnection().listSessions(params);
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
		const sessions = await this.listSessions(
			cwd ? { cwd: path.resolve(cwd) } : {},
		);
		return sessions.map(acpSessionToAiSession);
	}

	async listAiSessionsPage(cwd?: string, cursor?: string) {
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
		const updates: acp.SessionNotification[] = [];
		const listener = (notification: acp.SessionNotification) => {
			updates.push(notification);
		};
		this.client.addAnySessionUpdateListener(listener);
		try {
			const raw = await this.requireConnection().newSession({
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
			return {
				response,
				session,
				updates: updates.filter(
					(update) => update.sessionId === response.sessionId,
				),
			};
		} finally {
			this.client.removeAnySessionUpdateListener(listener);
		}
	}

	async resumeSession(params: acp.ResumeSessionRequest) {
		await this.ensureReady();
		if (!this.capabilities?.sessionCapabilities?.resume) {
			throw new UnsupportedCapabilityError(this.id, "session/resume");
		}

		const raw = await this.requireConnection().resumeSession({
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

		const raw = await this.requireConnection().unstable_forkSession({
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

		const response = await this.requireConnection().closeSession(params);
		this.sessions.delete(params.sessionId);
		this.transcripts.delete(params.sessionId);
		this.client.cancelSessionPermissions(params.sessionId);
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

		try {
			const raw = await this.requireConnection().loadSession({
				...params,
				cwd: path.resolve(params.cwd),
				mcpServers: params.mcpServers ?? [],
			});
			const response = this.safeParse(
				"session/load",
				zLoadSessionResponse,
				raw,
			);
			this.transcripts.set(sessionId, transcript);
			const messages = transcript.getMessages();
			const existing = this.sessions.get(sessionId);
			this.sessions.set(sessionId, {
				session: existing?.session
					? {
							...existing.session,
							configOptions:
								response.configOptions ?? existing.session.configOptions,
							model: response.models?.currentModelId ?? existing.session.model,
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
		const transcript = this.getTranscript(params.sessionId);
		let permissionRequested = false;
		const updateTasks = new Set<Promise<void>>();
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
			const response = await this.requireConnection().prompt(params);
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
		}
	}

	async interrupt(params: acp.CancelNotification) {
		await this.ensureReady();
		this.client.cancelSessionPermissions(params.sessionId);
		return this.requireConnection().cancel(params);
	}

	async setSessionConfigOption(params: acp.SetSessionConfigOptionRequest) {
		await this.ensureReady();
		const raw = await this.requireConnection().setSessionConfigOption(params);
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
		return this.requireConnection().setSessionMode(params);
	}

	async setSessionModel(params: acp.SetSessionModelRequest) {
		await this.ensureReady();
		return this.requireConnection().unstable_setSessionModel(params);
	}

	requestPendingPermissions(clientId: string) {
		return this.client.requestPendingPermissions(clientId);
	}

	replyPermission(permissionId: string, optionId: string) {
		return this.client.replyPermission(permissionId, optionId);
	}

	getMessages(sessionId: string) {
		return (
			this.sessions.get(sessionId)?.messages ??
			this.transcripts.get(sessionId)?.getMessages() ??
			[]
		);
	}

	getSession(sessionId: string) {
		return this.sessions.get(sessionId)?.session ?? null;
	}

	destroy() {
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

	private requireConnection() {
		if (!this.connection) {
			throw new AgentUnavailableError(this.id, "connection is not initialized");
		}
		return this.connection;
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

	protected attachProcessListeners() {
		if (!this.spawnedAgent) return;
		const child = this.spawnedAgent.process;
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
	}
}

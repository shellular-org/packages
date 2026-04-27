import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";
import type { AiBackend } from "@shellular/protocol";

import { commandExists } from "@/utils";
import { AcpClient } from "./client";

/** Configuration for spawning an ACP agent subprocess. */
export interface AgentProcessConfig {
	name: AiBackend;
	/** The executable of agent on the system to check if it's available or not.
	 * eg. `codex`, `opencode`, `claude` etc.
	 */
	agentExec: "opencode" | "codex" | "claude";
	/** The executable to invoke (e.g. `"opencode"`, `"npx"`). */
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
 * Base class for ACP agent connections.
 *
 * Manages the lifecycle of a spawned agent subprocess, the JSON-RPC
 * connection over its stdio streams, and the `AcpClient` that handles
 * incoming requests and notifications from the agent.
 */
export class ACP {
	private client: AcpClient;
	private spawnedAgent: SpawnedAgent;
	private connection: acp.ClientSideConnection;
	private agentCapabilities: acp.AgentCapabilities | undefined;

	constructor(spawnedAgent: SpawnedAgent) {
		this.spawnedAgent = spawnedAgent;
		this.client = new AcpClient();
		this.connection = new acp.ClientSideConnection(
			(_agent) => this.client,
			this.spawnedAgent.stream,
		);
	}

	/**
	 * Performs the ACP initialization handshake with the agent.
	 * Must be called once before any other method.
	 */
	async init() {
		const initResult = await this.connection.initialize({
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: {
				fs: {
					readTextFile: true,
					writeTextFile: true,
				},
			},
		});

		this.agentCapabilities = initResult.agentCapabilities;

		return initResult;
	}

	/**
	 * Spawns the agent subprocess and wires up its stdio as an ACP stream.
	 * Returns `null` if the executable is not found on `PATH`.
	 */
	static spawnAgentProcess(config: AgentProcessConfig): SpawnedAgent | null {
		if (!commandExists(config.agentExec)) {
			return null;
		}

		// Spawn the agent as a subprocess
		const agentProcess = spawn(config.command, config.args);

		// Create streams to communicate with the agent
		const input = Writable.toWeb(agentProcess.stdin);
		const output = Readable.toWeb(
			agentProcess.stdout,
		) as ReadableStream<Uint8Array>;

		const stream = acp.ndJsonStream(input, output);

		return {
			processConfig: config,
			process: agentProcess,
			stream,
		};
	}

	/**
	 * Lists all sessions, automatically paginating through all pages.
	 */
	async listSessions(
		params: acp.ListSessionsRequest,
	): Promise<acp.SessionInfo[]> {
		// get first page
		const result = await this.connection.listSessions(params);

		// if there are more pages, get them all
		const all: acp.SessionInfo[] = [...result.sessions];
		if (result.nextCursor) {
			const more = await this.listSessions({
				...params,
				cursor: result.nextCursor,
			});
			all.push(...more);
		}

		return all;
	}

	/**
	 * https://agentclientprotocol.com/protocol/session-setup#loading-a-session
	 *
	 * The agent streams all session/update notifications before resolving the
	 * session/load response, so awaiting this method guarantees all updates
	 * have been collected.
	 */
	async loadSession(params: acp.LoadSessionRequest): Promise<{
		response: acp.LoadSessionResponse;
		updates: acp.SessionNotification[];
	}> {
		if (!this.agentCapabilities?.loadSession) {
			throw new Error(
				`Agent ${this.spawnedAgent.processConfig.agentExec} does not support loading sessions`,
			);
		}

		const updates: acp.SessionNotification[] = [];
		const listener = (n: acp.SessionNotification) => updates.push(n);
		this.client.addSessionUpdateListener(params.sessionId, listener);

		try {
			const response = await this.connection.loadSession(params);
			return { response, updates };
		} finally {
			this.client.removeSessionUpdateListener(params.sessionId, listener);
		}
	}

	/**
	 * Sends a prompt to the agent and streams updates to the UI in real-time.
	 *
	 * The `onUpdate` callback is invoked immediately for every `session/update`
	 * notification the agent sends during the turn (message chunks, tool calls,
	 * plan updates, etc.), enabling live rendering in the app UI.
	 *
	 * The returned promise resolves with the final {@link acp.PromptResponse}
	 * (including `stopReason` and `usage`) once the turn is complete.
	 *
	 * @param params   - The prompt request (sessionId + content blocks).
	 * @param onUpdate - Called in real-time for each session update notification.
	 *
	 * @see https://agentclientprotocol.com/protocol/prompt-turn
	 */
	async prompt(
		params: acp.PromptRequest,
		onUpdate: (notification: acp.SessionNotification) => void,
	): Promise<acp.PromptResponse> {
		this.client.addSessionUpdateListener(params.sessionId, onUpdate);

		try {
			return await this.connection.prompt(params);
		} finally {
			this.client.removeSessionUpdateListener(params.sessionId, onUpdate);
		}
	}

	/** Cancels any ongoing work for the given session. */
	interrupt(params: acp.CancelNotification) {
		return this.connection.cancel(params);
	}

	/** Kills the agent subprocess and releases all resources. */
	destroy() {
		this.spawnedAgent.process.kill();
	}
}

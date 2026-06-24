import type * as acp from "@agentclientprotocol/sdk";
import type {
	AcpAiSession,
	AcpMessage,
	AiBackend,
	AiEvent,
} from "@shellular/protocol";

export type AgentConnectionState =
	| "unavailable"
	| "starting"
	| "ready"
	| "failed"
	| "exited";

export interface AgentSpawnCommand {
	command: string;
	args: string[];
	env?: Record<string, string>;
	cwd?: string;
}

export type SUPPORTED_OS = "windows" | "macos" | "linux" | "all";

export interface AgentDescriptor {
	id: AiBackend;
	name: string;
	title: string;
	version?: string;
	disabled?: boolean;
	source?: "builtin" | "custom";
	registryId?: string;
	description?: string;
	icon?: string;
	/**
	 * Optional informational note about the agent, surfaced in the app (e.g.
	 * behind an info icon on the sessions page). Use for caveats like which
	 * sessions are listed or minimum required versions.
	 */
	note?: string;
	/**
	 * Command to check if an agent is available.
	 *
	 * Example:
	 * If we wanna check whether the user is using codex or not, we simply check
	 * if the `codex` command is available. Note that we check for the existence of the
	 * `codex` command and not `npx`, because
	 * 1. we wanna check if that specific agent is available, not just npx
	 * 2. we can assume that it's installed because the user runs our CLI via `npx shellular`, so npx should be available.
	 */
	agentExecutable: string;
	spawn: AgentSpawnCommand;
	installationCommands: Record<
		string,
		{
			os: SUPPORTED_OS[];
			command: string;
		}
	>;
}

export interface AgentInfo {
	id: string;
	backend?: AiBackend;
	name: string;
	title: string;
	version?: string;
	description?: string;
	note?: string;
	icon?: string;
	source?: "builtin" | "custom";
	state: AgentConnectionState;
	enabled?: boolean;
	installed?: boolean;
	available: boolean;
	error?: string;
	capabilities?: acp.AgentCapabilities;
	installationCommands?: AgentDescriptor["installationCommands"];
	adapter?: { command: string; available: boolean };
}

export interface PromptCallbacks {
	onEvent?: (event: AiEvent) => void;
	onUpdate?: (notification: acp.SessionNotification) => void;
}

export interface LoadSessionResult {
	response: acp.LoadSessionResponse;
	updates: acp.SessionNotification[];
	messages: AcpMessage[];
}

/**
 * An authoritative transcript read from an agent's native session API.
 *
 * Native history is deliberately not persisted by Shellular: another harness
 * may update the same session at any time, so every attach must read from the
 * agent that owns the session.
 */
export interface NativeSessionHistory {
	messages: AcpMessage[];
}

export interface NativeSessionHistoryRequest extends acp.LoadSessionRequest {
	cursor?: string;
	limit?: number;
}

export interface PromptResult {
	response: acp.PromptResponse;
	messages: AcpMessage[];
}

export interface PermissionRequestEvent {
	id: string;
	sessionId: string;
	toolCall: acp.ToolCallUpdate;
	options: acp.PermissionOption[];
	raw: acp.RequestPermissionRequest;
}

export interface StoredSession {
	session: AcpAiSession;
	messages: AcpMessage[];
}

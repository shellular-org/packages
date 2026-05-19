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
	description?: string;
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
	icon?: string;
	state: AgentConnectionState;
	available: boolean;
	error?: string;
	capabilities?: acp.AgentCapabilities;
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

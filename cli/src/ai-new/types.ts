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

export type AgentSource = "builtin";

export interface AgentSpawnCommand {
	command: string;
	args: string[];
	env?: Record<string, string>;
	cwd?: string;
	checkCommand?: string;
}

export interface AgentDescriptor {
	id: string;
	backend?: AiBackend;
	name: string;
	title: string;
	version?: string;
	description?: string;
	icon?: string;
	source: AgentSource;
	spawn: AgentSpawnCommand;
}

export interface AgentInfo {
	id: string;
	backend?: AiBackend;
	name: string;
	title: string;
	version?: string;
	description?: string;
	icon?: string;
	source: AgentSource;
	state: AgentConnectionState;
	available: boolean;
	error?: string;
	capabilities?: acp.AgentCapabilities;
	adapter?: {
		command: string;
		available: boolean;
	};
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

import type {
	AiEvent,
	AiMessage,
	AiSession,
	ProviderInfo,
	ShareInfo,
} from "@shellular/protocol";

export type { AiEvent, ProviderInfo, ShareInfo };

// Callback the provider calls to push events to the mobile app.
export type AiEventEmitter = (clientId: string, event: AiEvent) => void;

// ─── Selection & options ────────────────────────────────────────────────────

export interface ModelSelector {
	providerID: string;
	modelID: string;
}

export interface CodexPromptOptions {
	reasoningEffort?: "low" | "medium" | "high";
	speed?: "fast" | "balanced" | "quality";
}

export interface FileAttachment {
	type: "file";
	mime: string;
	filename?: string;
	url: string;
}

// ─── Provider interface ─────────────────────────────────────────────────────

/**
 * Every AI backend (OpenCode, Codex, Copilot) implements this interface.
 */
export interface AIProvider {
	init(): Promise<void>;
	destroy(): Promise<void>;
	subscribe(emitter: (clientId: string, event: AiEvent) => void): () => void;
	setActiveSession?(sessionId: string): void;
	createSession(
		clientId: string,
		prompt: string,
		workspacePath: string,
	): Promise<AiSession>;
	listSessions(clientId: string): Promise<AiSession[]>;
	getSession(clientId: string, id: string): Promise<AiSession>;
	deleteSession(clientId: string, id: string): Promise<boolean>;
	getMessages(clientId: string, sessionId: string): Promise<AiMessage[]>;
	prompt(
		clientId: string,
		sessionId: string,
		prompt: string,
		model?: ModelSelector,
		agent?: string,
		files?: FileAttachment[],
		codexOptions?: CodexPromptOptions,
	): Promise<{ ack: true }>;
	abort(sessionId: string, clientId: string): Promise<Record<string, never>>;
	agents(clientId: string): Promise<unknown[]>;
	providers(clientId: string): Promise<ProviderInfo>;
	setAuth(
		clientId: string,
		providerId: string,
		key: string,
	): Promise<Record<string, never>>;
	command(
		clientId: string,
		sessionId: string,
		command: string,
		args: string,
	): Promise<{ result: unknown }>;
	revert(
		clientId: string,
		sessionId: string,
		messageId: string,
	): Promise<Record<string, never>>;
	unrevert(clientId: string, sessionId: string): Promise<Record<string, never>>;
	share(clientId: string, sessionId: string): Promise<ShareInfo>;
	permissionReply(
		clientId: string,
		sessionId: string,
		permissionId: string,
		response: "once" | "always" | "reject",
	): Promise<Record<string, never>>;
	questionReply?(
		clientId: string,
		sessionId: string,
		questionId: string,
		answers: string[][],
	): Promise<Record<string, never>>;
	questionReject?(
		clientId: string,
		sessionId: string,
		questionId: string,
	): Promise<Record<string, never>>;
}

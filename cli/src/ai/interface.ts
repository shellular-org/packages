import type {
	AiEvent,
	AiMessage,
	AiMessagePart,
	AiSession,
	ProviderInfo,
	ShareInfo,
} from "@shellular/protocol";

export type { AiEvent, ProviderInfo, ShareInfo };

// ─── Streaming events ──────────────────────────────────────────────────────

export interface TokenEvent {
	type: "token";
	properties: {
		sessionId: string;
		text: string;
		itemId?: string;
	};
}

export interface MessageEvent {
	type: "message";
	properties: {
		id: string;
		role: string;
		text: string;
		timestamp: number;
		sessionId?: string;
		parts?: AiMessagePart[];
	};
}

export interface EndEvent {
	type: "end";
	properties: {
		sessionId: string;
	};
}

export interface ErrorEvent {
	type: "error";
	properties: {
		sessionId?: string;
		error: string;
	};
}

export interface PromptErrorEvent {
	type: "prompt_error";
	properties: {
		sessionId?: string;
		error: string;
	};
}

export interface SessionStatusEvent {
	type: "session.status";
	properties: {
		sessionId: string;
		status: unknown;
	};
}

export interface SessionGcEvent {
	type: "session_gc";
	properties: {
		sessionId: string;
	};
}

export interface SseDeadEvent {
	type: "sse_dead";
	properties: {
		error: string;
		attempts: number;
	};
}

export interface PermissionUpdatedEvent {
	type: "permission.updated";
	properties: {
		id: string;
		sessionId: string;
		messageId?: string;
		callId?: string;
		kind: string;
		title: string;
		metadata?: unknown;
	};
}

export interface PermissionRepliedEvent {
	type: "permission.replied";
	properties: {
		permissionId: string;
	};
}

export interface QuestionAskedEvent {
	type: "question.asked";
	properties: {
		id: string;
		sessionId: string;
		questions: unknown[];
		tool?: unknown;
	};
}

export interface QuestionRepliedEvent {
	type: "question.replied";
	properties: {
		sessionId: string;
		requestId: string;
		answers: string[][];
	};
}

export interface QuestionRejectedEvent {
	type: "question.rejected";
	properties: {
		sessionId: string;
		requestId: string;
	};
}

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

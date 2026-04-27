import type * as acp from "@agentclientprotocol/sdk";
import type {
	AcpAiSession,
	AiEvent,
	AiMessage,
	AiMessagePart,
} from "@shellular/protocol";
import { nanoid } from "nanoid";

function now() {
	return Date.now();
}

function textFromContent(content: unknown): string {
	if (
		content &&
		typeof content === "object" &&
		"type" in content &&
		content.type === "text" &&
		"text" in content &&
		typeof content.text === "string"
	) {
		return content.text;
	}
	return "";
}

function appendPart(message: AiMessage, part: AiMessagePart) {
	message.parts = [...(message.parts ?? []), part];
}

function appendText(message: AiMessage, text: string) {
	if (!text) return;
	const last = message.parts[message.parts.length - 1];
	if (last?.type === "text") {
		last.text += text;
		return;
	}
	appendPart(message, { type: "text", text });
}

export class AcpTranscript {
	private messages: AiMessage[] = [];
	private currentUser: AiMessage | null = null;
	private currentAssistant: AiMessage | null = null;
	private toolParts = new Map<string, AiMessagePart & { type: "tool_call" }>();

	constructor(readonly sessionId: string) {}

	getMessages(): AiMessage[] {
		return this.messages.map((message) => ({
			...message,
			parts: [...message.parts],
		}));
	}

	apply(notification: acp.SessionNotification): AiEvent[] {
		const update = notification.update;
		const events: AiEvent[] = [];

		switch (update.sessionUpdate) {
			case "user_message_chunk": {
				this.currentAssistant = null;
				const message = this.ensureCurrentUser();
				appendText(message, textFromContent(update.content));
				events.push(this.messageEvent(message));
				break;
			}
			case "agent_message_chunk": {
				this.currentUser = null;
				const text = textFromContent(update.content);
				const message = this.ensureCurrentAssistant();
				appendText(message, text);
				if (text) {
					events.push({
						type: "token",
						properties: { sessionId: this.sessionId, text, itemId: message.id },
					});
				}
				events.push(this.messageEvent(message));
				break;
			}
			case "agent_thought_chunk": {
				this.currentUser = null;
				const text = textFromContent(update.content);
				if (!text) break;
				const message = this.ensureCurrentAssistant();
				const last = message.parts[message.parts.length - 1];
				if (last?.type === "reasoning") {
					last.content += text;
				} else {
					appendPart(message, {
						type: "reasoning",
						content: text,
						summary: "Reasoning",
					});
				}
				events.push(this.messageEvent(message));
				break;
			}
			case "tool_call": {
				this.currentUser = null;
				const message = this.ensureCurrentAssistant();
				const part: AiMessagePart & { type: "tool_call" } = {
					id: update.toolCallId,
					type: "tool_call",
					name: update.kind ?? "tool",
					title: update.title,
					arguments:
						update.rawInput === undefined
							? undefined
							: JSON.stringify(update.rawInput, null, 2),
					output:
						update.rawOutput === undefined
							? undefined
							: JSON.stringify(update.rawOutput, null, 2),
					status: update.status,
				};
				this.toolParts.set(update.toolCallId, part);
				appendPart(message, part);
				events.push(this.messageEvent(message));
				break;
			}
			case "tool_call_update": {
				this.currentUser = null;
				const message = this.ensureCurrentAssistant();
				let part = this.toolParts.get(update.toolCallId);
				if (!part) {
					part = {
						id: update.toolCallId,
						type: "tool_call",
						name: update.kind ?? "tool",
						title: update.title ?? update.toolCallId,
						status: update.status ?? undefined,
					};
					this.toolParts.set(update.toolCallId, part);
					appendPart(message, part);
				}
				if (update.kind) part.name = update.kind;
				if (update.title) part.title = update.title;
				if (update.status) part.status = update.status;
				if (update.rawInput !== undefined) {
					part.arguments = JSON.stringify(update.rawInput, null, 2);
				}
				if (update.rawOutput !== undefined) {
					part.output = JSON.stringify(update.rawOutput, null, 2);
				}
				events.push(this.messageEvent(message));
				break;
			}
			case "plan": {
				this.currentUser = null;
				const message = this.ensureCurrentAssistant();
				appendPart(message, {
					type: "plan",
					content: update.entries
						.map((entry) => `${entry.status}: ${entry.content}`)
						.join("\n"),
					summary: "Plan",
				});
				events.push(this.messageEvent(message));
				break;
			}
			case "session_info_update": {
				events.push({
					type: "session.status",
					properties: { sessionId: this.sessionId, status: update },
				});
				break;
			}
			case "usage_update":
			case "available_commands_update":
			case "current_mode_update":
			case "config_option_update": {
				events.push({
					type: "session.status",
					properties: {
						sessionId: this.sessionId,
						status: update,
						...(update.sessionUpdate === "config_option_update"
							? { configOptions: update.configOptions }
							: {}),
					},
				});
				break;
			}
			default:
				events.push({
					type: "session.status",
					properties: { sessionId: this.sessionId, status: update },
				});
		}

		return events;
	}

	private ensureCurrentUser(): AiMessage {
		if (!this.currentUser) {
			this.currentUser = {
				id: nanoid(),
				role: "user",
				parts: [],
				timestamp: now(),
			};
			this.messages.push(this.currentUser);
		}
		return this.currentUser;
	}

	private ensureCurrentAssistant(): AiMessage {
		if (!this.currentAssistant) {
			this.currentAssistant = {
				id: nanoid(),
				role: "assistant",
				parts: [],
				timestamp: now(),
			};
			this.messages.push(this.currentAssistant);
		}
		return this.currentAssistant;
	}

	private messageEvent(message: AiMessage): AiEvent {
		return {
			type: "message",
			properties: {
				id: message.id,
				role: message.role,
				text: message.parts
					.filter((part) => part.type === "text")
					.map((part) => ("text" in part ? part.text : ""))
					.join(""),
				timestamp: message.timestamp ?? now(),
				sessionId: this.sessionId,
				message,
			},
		};
	}
}

export function acpSessionToAiSession(session: acp.SessionInfo): AcpAiSession {
	const updated = session.updatedAt
		? Date.parse(session.updatedAt)
		: Date.now();
	return {
		id: session.sessionId,
		title: session.title ?? "Untitled Chat",
		createdAt:
			typeof session._meta?.createdAt === "string"
				? Date.parse(session._meta.createdAt)
				: updated,
		updatedAt: Number.isFinite(updated) ? updated : Date.now(),
		workspacePath: session.cwd,
	};
}

export function newAiSessionFromResponse(
	response:
		| acp.NewSessionResponse
		| acp.LoadSessionResponse
		| acp.ResumeSessionResponse
		| acp.ForkSessionResponse,
	cwd: string,
	sessionId = "sessionId" in response ? response.sessionId : undefined,
): AcpAiSession {
	const ts = Date.now();
	return {
		id: sessionId,
		title: "New Chat",
		createdAt: ts,
		updatedAt: ts,
		workspacePath: cwd,
		configOptions: response.configOptions ?? undefined,
		model: response.models?.currentModelId,
	};
}

export function promptEndEvent(
	sessionId: string,
	response: acp.PromptResponse,
): AiEvent {
	return {
		type: response.stopReason === "cancelled" ? "cancelled" : "end",
		properties: {
			sessionId,
			stopReason: response.stopReason,
			usage: response.usage,
		},
	};
}

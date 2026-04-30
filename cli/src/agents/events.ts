import type * as acp from "@agentclientprotocol/sdk";
import type {
	AcpAiSession,
	AcpContentBlock,
	AcpMessage,
	AcpMessagePart,
	AiEvent,
} from "@shellular/protocol";
import { nanoid } from "nanoid";

type AcpToolCallPart = AcpMessagePart & {
	type: "tool_call";
	parts?: AcpMessagePart[];
};

export interface AcpTranscriptOptions {
	shouldSkipUserReplayContent?: (content: unknown) => boolean;
	normalizeUserReplayMessage?: (message: AcpMessage) => AcpMessage | null;
}

function now() {
	return Date.now();
}

export function textFromContent(content: unknown): string {
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

function annotationTitle(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const title = (value as Record<string, unknown>).title;
	return typeof title === "string" ? title : undefined;
}

function dataUrl(mimeType: string, data: string) {
	return `data:${mimeType};base64,${data}`;
}

function diffKind(content: acp.ToolCallContent & { type: "diff" }) {
	if (content.oldText === null || content.oldText === undefined)
		return "create";
	return "edit";
}

function filePathFromUri(uri: string) {
	return uri.replace(/^file:\/\//, "");
}

function contentToPart(content: unknown): AcpMessagePart | null {
	if (!content || typeof content !== "object" || !("type" in content))
		return null;
	const c = content as Record<string, unknown>;
	switch (c.type) {
		case "text":
			return typeof c.text === "string"
				? { type: "text", text: c.text, rawContent: content }
				: null;
		case "image":
			if (typeof c.data === "string" && typeof c.mimeType === "string") {
				return {
					type: "image",
					src: dataUrl(c.mimeType, c.data),
					alt: annotationTitle(c.annotations) ?? "Image",
					mime: c.mimeType,
					uri: typeof c.uri === "string" ? c.uri : undefined,
					rawContent: content,
				};
			}
			if (typeof c.uri === "string") {
				return {
					type: "image",
					src: c.uri,
					alt: annotationTitle(c.annotations) ?? "Image",
					mime: typeof c.mimeType === "string" ? c.mimeType : undefined,
					uri: c.uri,
					rawContent: content,
				};
			}
			return null;
		case "audio":
			if (typeof c.data === "string" && typeof c.mimeType === "string") {
				return {
					type: "audio",
					src: dataUrl(c.mimeType, c.data),
					mime: c.mimeType,
					rawContent: content,
				};
			}
			if (typeof c.uri === "string") {
				return {
					type: "audio",
					src: c.uri,
					mime: typeof c.mimeType === "string" ? c.mimeType : undefined,
					uri: c.uri,
					rawContent: content,
				};
			}
			return null;
		case "resource": {
			const res = c.resource as Record<string, unknown> | undefined;
			if (!res) return null;
			const uri = typeof res.uri === "string" ? res.uri : undefined;
			const mimeType =
				typeof res.mimeType === "string" ? res.mimeType : undefined;
			if (uri?.startsWith("file://")) {
				return {
					type: "file_reference",
					path: filePathFromUri(uri),
					mimeType,
					name: uri.split("/").pop(),
					rawContent: content,
				};
			}
			if (typeof res.text === "string") {
				return {
					type: "resource",
					uri: uri ?? "resource:",
					name: uri?.split("/").pop(),
					mimeType,
					text: res.text,
					rawContent: content,
				};
			}
			if (typeof res.blob === "string") {
				return {
					type: "resource",
					uri: uri ?? "resource:",
					name: uri?.split("/").pop(),
					mimeType,
					blob: res.blob,
					rawContent: content,
				};
			}
			return uri
				? {
						type: "resource",
						uri,
						name: uri.split("/").pop(),
						mimeType,
						rawContent: content,
					}
				: null;
		}
		case "resource_link": {
			const uri = typeof c.uri === "string" ? c.uri : "";
			const common = {
				name: typeof c.name === "string" ? c.name : undefined,
				title: typeof c.title === "string" ? c.title : undefined,
				description:
					typeof c.description === "string" ? c.description : undefined,
				mimeType: typeof c.mimeType === "string" ? c.mimeType : undefined,
				size: typeof c.size === "number" ? c.size : undefined,
				rawContent: content,
			};
			if (uri.startsWith("file://")) {
				return {
					type: "file_reference",
					path: filePathFromUri(uri),
					...common,
				};
			}
			if (uri.startsWith("http")) {
				return {
					type: "web_reference",
					url: uri,
					title: common.title ?? common.name,
					description: common.description,
					mimeType: common.mimeType,
					size: common.size,
					rawContent: content,
				};
			}
			return uri
				? {
						type: "resource",
						uri,
						...common,
					}
				: null;
		}
		default:
			return null;
	}
}

function appendContent(
	message: AcpMessage,
	content: AcpContentBlock | unknown,
) {
	const part = contentToPart(content);
	if (!part) {
		appendText(message, textFromContent(content));
		return;
	}
	if (part.type === "text") {
		appendText(message, part.text);
		return;
	}
	appendPart(message, part);
}

function appendPart(message: AcpMessage, part: AcpMessagePart) {
	message.parts = [...(message.parts ?? []), part];
}

function appendText(message: AcpMessage, text: string) {
	if (!text) return;
	const resourceLinkParts = partsFromResourceLinkText(text);
	if (resourceLinkParts) {
		for (const part of resourceLinkParts) {
			if (part.type === "text") appendPlainText(message, part.text);
			else appendPart(message, part);
		}
		return;
	}
	appendPlainText(message, text);
}

function appendPlainText(message: AcpMessage, text: string) {
	const last = message.parts[message.parts.length - 1];
	if (last?.type === "text") {
		last.text += text;
		return;
	}
	appendPart(message, { type: "text", text });
}

function partsFromResourceLinkText(text: string): AcpMessagePart[] | null {
	const markerPattern = /\[Resource link:\s*(file:\/\/[^\]]+)\]/g;
	const parts: AcpMessagePart[] = [];
	let lastIndex = 0;
	let match = markerPattern.exec(text);

	while (match) {
		const before = text.slice(lastIndex, match.index);
		if (before) parts.push({ type: "text", text: before });
		const uri = match[1]?.trim();
		if (uri) {
			parts.push({
				type: "file_reference",
				path: filePathFromUri(uri),
				name: uri.split("/").pop(),
				rawContent: { type: "resource_link", uri },
			} as AcpMessagePart);
		}
		lastIndex = markerPattern.lastIndex;
		match = markerPattern.exec(text);
	}

	if (!parts.length) return null;
	const after = text.slice(lastIndex);
	if (after) parts.push({ type: "text", text: after });
	return parts;
}

function appendPromptContent(
	message: AcpMessage,
	prompt: acp.PromptRequest["prompt"],
) {
	for (const content of prompt) {
		appendContent(message, content);
	}
}

function hasText(message: AcpMessage, text: string) {
	const normalized = text.trim();
	if (!normalized) return false;
	return message.parts.some(
		(part) => part.type === "text" && part.text.trim() === normalized,
	);
}

export class AcpTranscript {
	private messages: AcpMessage[] = [];
	private currentUser: AcpMessage | null = null;
	private currentAssistant: AcpMessage | null = null;
	private toolParts = new Map<string, AcpToolCallPart>();

	constructor(
		readonly sessionId: string,
		private readonly options: AcpTranscriptOptions = {},
	) {}

	getMessages(): AcpMessage[] {
		return this.messages.flatMap((message) => {
			const normalized = this.normalizeMessage(message);
			return normalized
				? [
						{
							...normalized,
							parts: [...normalized.parts],
						},
					]
				: [];
		});
	}

	beginTurn(prompt?: acp.PromptRequest["prompt"]) {
		this.currentUser = null;
		this.currentAssistant = null;
		this.toolParts.clear();
		if (prompt?.length) appendPromptContent(this.ensureCurrentUser(), prompt);
	}

	endTurn(stopReason?: string) {
		if (stopReason && stopReason !== "end_turn") {
			this.appendStopReason(stopReason);
		}
		this.currentUser = null;
		this.currentAssistant = null;
		this.toolParts.clear();
	}

	apply(notification: acp.SessionNotification): AiEvent[] {
		const update = notification.update;
		const events: AiEvent[] = [];

		switch (update.sessionUpdate) {
			case "user_message_chunk": {
				if (this.options.shouldSkipUserReplayContent?.(update.content)) break;
				this.currentAssistant = null;
				const message = this.ensureCurrentUser();
				const userPart = contentToPart(update.content);
				if (userPart) {
					if (userPart.type === "text") {
						if (!hasText(message, userPart.text)) {
							appendText(message, userPart.text);
						}
					} else {
						appendPart(message, userPart);
					}
				} else {
					const text = textFromContent(update.content);
					if (!hasText(message, text)) appendText(message, text);
				}
				const normalizedMessage = this.replaceWithNormalizedMessage(message);
				if (normalizedMessage)
					events.push(this.messageEvent(normalizedMessage));
				break;
			}
			case "agent_message_chunk": {
				this.currentUser = null;
				const message = this.ensureCurrentAssistant();
				const text = textFromContent(update.content);
				appendContent(message, update.content);
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
				const part: AcpToolCallPart = {
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
				if (update.content?.length) {
					part.parts = toolContentToParts(update.content);
				}
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
				if (update.content?.length) {
					part.parts = toolContentToParts(update.content);
				}
				events.push(this.messageEvent(message));
				break;
			}
			case "plan": {
				this.currentUser = null;
				const message = this.ensureCurrentAssistant();
				const entries = update.entries.map((entry) => ({
					content: entry.content,
					status: entry.status,
					priority: entry.priority,
				}));
				const existingPlanIndex = message.parts.findIndex(
					(part) => part.type === "plan",
				);
				const planPart = {
					type: "plan" as const,
					content: entries
						.map((entry) =>
							entry.status
								? `${entry.status}: ${entry.content}`
								: entry.content,
						)
						.join("\n"),
					entries,
					summary: "Plan",
				};
				if (existingPlanIndex >= 0) {
					message.parts[existingPlanIndex] = planPart;
				} else {
					appendPart(message, planPart);
				}
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
			case "available_commands_update": {
				events.push({
					type: "session.status",
					properties: {
						sessionId: this.sessionId,
						status: update,
						availableCommands: update.availableCommands,
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

	private normalizeMessage(message: AcpMessage): AcpMessage | null {
		if (message.role !== "user") return message;
		return this.options.normalizeUserReplayMessage?.(message) ?? message;
	}

	private replaceWithNormalizedMessage(message: AcpMessage): AcpMessage | null {
		const normalized = this.normalizeMessage(message);
		const index = this.messages.indexOf(message);
		if (!normalized) {
			if (index >= 0) this.messages.splice(index, 1);
			if (this.currentUser === message) this.currentUser = null;
			return null;
		}
		if (normalized !== message && index >= 0) {
			this.messages[index] = normalized;
		}
		if (this.currentUser === message) this.currentUser = normalized;
		return normalized;
	}

	private ensureCurrentUser(): AcpMessage {
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

	private ensureCurrentAssistant(): AcpMessage {
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

	private messageEvent(message: AcpMessage): AiEvent {
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

	private appendStopReason(stopReason: string) {
		const message = this.currentAssistant ?? this.ensureCurrentAssistant();
		const text = formatStopReason(stopReason);
		if (!text) return;
		message.parts = [
			...message.parts.filter(
				(part) =>
					!(
						part.type === "text" &&
						"metadata" in part &&
						(part as { metadata?: unknown }).metadata === "stop-reason"
					),
			),
			{
				type: "text",
				text,
				metadata: "stop-reason",
			},
		];
	}
}

function formatStopReason(stopReason: string) {
	switch (stopReason) {
		case "cancelled":
			return "_Stopped by user._";
		case "max_tokens":
			return "_Stopped: maximum token limit reached._";
		case "max_turn_requests":
			return "_Stopped: maximum turn requests reached._";
		case "refusal":
			return "_Stopped: request refused._";
		default:
			return stopReason === "end_turn"
				? ""
				: `_Stopped: ${stopReason.replace(/_/g, " ")}._`;
	}
}

function toolContentToParts(contents: acp.ToolCallContent[]): AcpMessagePart[] {
	return contents.flatMap((content) => {
		switch (content.type) {
			case "content": {
				const part = contentToPart(content.content);
				return part ? [part] : [];
			}
			case "diff":
				return [
					{
						type: "file_change" as const,
						path: content.path,
						kind: diffKind(content),
						diff: {
							old: content.oldText ?? "",
							new: content.newText,
						},
						status: "completed",
						rawContent: content,
					},
				];
			case "terminal":
				return [
					{
						type: "command" as const,
						command: `terminal:${content.terminalId}`,
						status: "terminal",
						rawContent: content,
					},
				];
			default:
				return [];
		}
	});
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

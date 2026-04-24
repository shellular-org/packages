import type { AiMessagePart } from "@shellular/protocol";
import type { AiEvent } from "./interface";

interface RawEvent {
	type: string;
	properties: Record<string, unknown>;
}

interface PartProperties {
	sessionId?: string;
	type?: string;
	text?: string;
	itemId?: string;
	parts?: AiMessagePart[];
}

interface MessagePartInfo {
	id?: string;
	role?: string;
	time?: unknown;
	timestamp?: unknown;
	parts?: AiMessagePart[];
}

export function normalizeAiEvent(event: AiEvent | RawEvent): AiEvent {
	if (
		event.type === "token" &&
		"sessionId" in event.properties &&
		"text" in event.properties
	) {
		return event as AiEvent;
	}

	if (
		event.type === "message" &&
		"id" in event.properties &&
		"role" in event.properties
	) {
		return event as AiEvent;
	}

	const { type, properties } = event as RawEvent;

	if (type === "message.part.updated" || type === "message/part/updated") {
		const part = properties?.part as PartProperties | undefined;
		if (!part) return event as AiEvent;

		let text = "";
		if (typeof part.text === "string") {
			text = part.text;
		} else if (
			Array.isArray(part.parts) &&
			part.parts.length > 0 &&
			part.parts[0].type === "text"
		) {
			text = part.parts[0].text;
		}

		return {
			type: "token",
			properties: {
				sessionId:
					part.sessionId ??
					(properties.message as Record<string, unknown> | undefined)
						?.sessionId ??
					"",
				text,
			},
		};
	}

	if (type === "session.updated") {
		const info = properties?.info as MessagePartInfo | undefined;
		if (!info) return event as AiEvent;

		const text = extractTextFromMessageParts(info.parts || []);

		if (!text && !info.role) return event as AiEvent;

		return {
			type: "message",
			properties: {
				id: info.id || String(Date.now()),
				role: info.role || "assistant",
				text,
				timestamp: normalizeToNumber(info.time || info.timestamp || Date.now()),
			},
		};
	}

	if (type === "message.completed") {
		const message = (properties?.message || properties) as
			| MessagePartInfo
			| undefined;
		if (!message) return event as AiEvent;

		const text = extractTextFromMessageParts(message.parts || []);

		return {
			type: "message",
			properties: {
				id: message.id || String(Date.now()),
				role: message.role || "assistant",
				text,
				timestamp: normalizeToNumber(
					message.time || message.timestamp || Date.now(),
				),
			},
		};
	}

	if (type === "turn/completed" || type === "turn.completed") {
		const sessionId =
			(properties?.sessionId as string) || (properties?.threadId as string);
		if (sessionId) {
			return {
				type: "end",
				properties: { sessionId },
			};
		}
	}

	if (type === "item/agentMessage/delta") {
		const itemId = properties?.itemId || "main";
		const text = properties?.text || (properties?.delta as string) || "";
		const sessionId =
			(properties?.sessionId as string) ||
			(properties?.threadId as string) ||
			"";

		return {
			type: "token",
			properties: { sessionId, itemId: itemId as string, text },
		};
	}

	if (type === "token") {
		return {
			type: "token",
			properties: {
				sessionId:
					(properties?.sessionId as string) ||
					(properties?.sessionId as string) ||
					"",
				text: (properties?.text as string) || "",
			},
		};
	}

	return event as AiEvent;
}

function normalizeToNumber(val: unknown): number {
	if (typeof val === "number") {
		return val < 1e11 ? val * 1000 : val;
	}
	if (typeof val === "string") {
		const parsed = Date.parse(val);
		if (!Number.isNaN(parsed)) return parsed;
	}
	return Date.now();
}

function extractTextFromMessageParts(parts: unknown[]): string {
	if (!Array.isArray(parts) || parts.length === 0) return "";

	for (const part of parts) {
		if (!part || typeof part !== "object") continue;

		const p = part as AiMessagePart;

		if (p.type === "text" && typeof p.text === "string" && p.text) {
			return p.text;
		}

		const rec = part as Record<string, unknown>;

		if (Array.isArray(rec.content) && rec.content.length > 0) {
			const nestedText = extractTextFromMessageParts(rec.content);
			if (nestedText) return nestedText;
		}

		if (typeof rec.text === "string" && rec.text) {
			return rec.text;
		}

		if (typeof rec.content === "string" && rec.content) {
			return rec.content;
		}

		if (rec.inlineReference && typeof rec.inlineReference === "object") {
			const ref = rec.inlineReference as Record<string, unknown>;
			if (typeof ref.text === "string" && ref.text) {
				return ref.text;
			}
		}
	}

	return "";
}

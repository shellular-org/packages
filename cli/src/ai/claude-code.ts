import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
	Query,
	SDKMessage,
	SDKSessionInfo,
} from "@anthropic-ai/claude-agent-sdk";
import {
	getSessionInfo,
	getSessionMessages,
	listSessions,
	query,
} from "@anthropic-ai/claude-agent-sdk";

import { logger } from "@/logger";
import type {
	AiMessage,
	AiMessagePart,
	AiMessagePartToolCall,
	AiSession,
} from "@shellular/protocol";
import type {
	ClaudeAssistantMessage,
	ClaudeSessionEntry,
} from "@/types/claude";
import type {
	AIProvider,
	AiEventEmitter,
	CodexPromptOptions,
	FileAttachment,
	ModelSelector,
	ProviderInfo,
	ShareInfo,
} from "./interface";

// ─── Helpers ────────────────────────────────────────────────────────────────

function claudeDir(): string {
	return path.join(os.homedir(), ".claude");
}

function sdkSessionToSessionInfo(s: SDKSessionInfo): AiSession {
	return {
		id: s.sessionId,
		workspacePath: s.cwd,
		updatedAt: s.lastModified,
		createdAt: s.createdAt ?? s.lastModified,
		title: s.customTitle || s.summary || s.firstPrompt || "Untitled",
	};
}

/**
 * Parse an assistant message's content blocks into MessageParts.
 * The `message` field for assistant SessionMessages is a BetaMessage
 * with a `content` array of blocks.
 */
function parseAssistantContent(msg: ClaudeAssistantMessage): AiMessagePart[] {
	const parts: AiMessagePart[] = [];
	if (!msg || typeof msg !== "object") return parts;

	const content = msg.content;

	for (const block of content) {
		if (!block || typeof block !== "object") continue;

		if (block.type === "text" && typeof block.text === "string") {
			if (block.text.trim()) {
				parts.push({ type: "text", text: block.text });
			}
		} else if (block.type === "tool_use") {
			switch (block.name.toLowerCase()) {
				case "read":
					parts.push({
						id: block.id,
						type: "file_reference",
						path: String(block.input.file_path),
					});
					break;
				case "write":
					parts.push({
						id: block.id,
						type: "file_change",
						path: String(block.input.file_path),
						kind: "write",
						diff: {
							old: "",
							new: String(block.input.content),
						},
					});
					break;
				case "edit":
					parts.push({
						id: block.id,
						type: "file_change",
						path: String(block.input.file_path),
						kind: "edit",
						diff: {
							old: String(block.input.old_string),
							new: String(block.input.new_string),
						},
					});
					break;
				case "grep":
					parts.push({
						id: block.id,
						type: "file_reference",
						path: String(block.input.path),
					});
					break;
				case "bash":
					parts.push({
						id: block.id,
						type: "command",
						command: String(block.input.command),
					});
					break;
				case "agent":
					parts.push({
						type: "tool_call",
						id: block.id,
						name: String(block.input.subagent_type),
						title: block.input?.description as string | undefined,
					});
					break;
			}
		} else if (block.type === "tool_result") {
			const toolCall = parts.find(
				(p) =>
					p.type === "tool_call" &&
					(p as { id: string }).id === String(block.tool_use_id),
			) as AiMessagePartToolCall | undefined;
			if (toolCall && typeof block.content === "string") {
				if (["tool_call", "command"].includes(toolCall.type)) {
					toolCall.output = block.content;
				}
			} else if (toolCall && Array.isArray(block.content)) {
				const [content] = block.content;
				if (content.text.trim()) {
					parts.push({
						type: "text",
						text: content.text,
					});
				}
			}
		} else if (block.type === "thinking") {
			if (typeof block.thinking === "string" && block.thinking.trim()) {
				parts.push({
					type: "reasoning",
					content: block.thinking,
				});
			}
		}
	}

	return parts;
}

// ─── Provider ───────────────────────────────────────────────────────────────

export class ClaudeCodeProvider implements AIProvider {
	private emitter: AiEventEmitter | null = null;
	private activeQuery: Query | null = null;
	private activeAbort: AbortController | null = null;

	async init(): Promise<void> {
		// Verify Claude Code is installed by checking ~/.claude/ exists
		const dir = claudeDir();
		if (!fs.existsSync(dir)) {
			throw Object.assign(
				new Error("Claude Code not found (~/.claude/ does not exist)"),
				{ code: "ENOENT" },
			);
		}
		logger.debug("Claude Code provider initialized");
	}

	async destroy(): Promise<void> {
		if (this.activeAbort) {
			this.activeAbort.abort();
			this.activeAbort = null;
		}
		if (this.activeQuery) {
			this.activeQuery.close();
			this.activeQuery = null;
		}
	}

	subscribe(emitter: AiEventEmitter): () => void {
		this.emitter = emitter;
		return () => {
			this.emitter = null;
		};
	}

	// ─── Session CRUD ─────────────────────────────────────────────────────

	async listSessions(_clientId: string) {
		const sessions = await listSessions();
		return sessions.map(sdkSessionToSessionInfo);
	}

	async getSession(_clientId: string, id: string) {
		const info = await getSessionInfo(id);
		if (!info) {
			throw new Error(`Session "${id}" not found`);
		}
		return sdkSessionToSessionInfo(info);
	}

	async createSession(_clientId: string, title?: string) {
		const prompt = title || "Hello";
		const abortController = new AbortController();
		const q = query({
			prompt,
			options: {
				abortController,
				maxTurns: 1,
				cwd: process.cwd(),
			},
		});

		let sessionId = "";
		for await (const msg of q) {
			if (msg.session_id) {
				sessionId = msg.session_id;
				break;
			}
		}

		// Clean up — we just needed the session ID
		abortController.abort();
		q.close();

		if (!sessionId) {
			throw new Error("Failed to create Claude Code session");
		}

		const info = await getSessionInfo(sessionId);
		if (info) {
			return sdkSessionToSessionInfo(info);
		}

		return {
			id: sessionId,
			title: title || "New Chat",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
	}

	async deleteSession(_clientId: string, _id: string): Promise<boolean> {
		throw new Error("Claude Code does not support session deletion");
	}

	// ─── Messages ─────────────────────────────────────────────────────────

	async getMessages(_clientId: string, sessionId: string) {
		const raw = (await getSessionMessages(sessionId)) as ClaudeSessionEntry[];
		const messages: AiMessage[] = [];

		for (const sm of raw) {
			if (sm.type === "user") {
				const text =
					typeof sm.message.content === "string" ? sm.message.content : "";

				if (text.trim()) {
					messages.push({
						id: sm.uuid,
						role: "user",
						parts: [
							{
								type: "text",
								text,
							},
						],
						timestamp: new Date(sm.timestamp).getTime(),
					});
					continue;
				}

				if (!Array.isArray(sm.message.content)) {
					continue;
				}
			}

			if (Array.isArray(sm.message.content)) {
				const parts = parseAssistantContent(
					sm.message as ClaudeAssistantMessage,
				);

				if (parts.length > 0) {
					messages.push({
						id: sm.uuid,
						role: "assistant",
						parts: parts,
						timestamp: new Date(sm.timestamp as string).getTime(),
						sessionId,
					});
				}
			}
		}

		return messages;
	}

	// ─── Prompting (streaming) ────────────────────────────────────────────

	async prompt(
		clientId: string,
		sessionId: string,
		text: string,
		_model?: ModelSelector,
		_agent?: string,
		_files?: FileAttachment[],
		_codexOptions?: CodexPromptOptions,
	): Promise<{ ack: true }> {
		const abortController = new AbortController();
		this.activeAbort = abortController;

		const q = query({
			prompt: text,
			options: {
				resume: sessionId,
				abortController,
				cwd: process.cwd(),
			},
		});
		this.activeQuery = q;

		// Run streaming in background — don't await the full stream
		this.streamQuery(clientId, sessionId, q).catch((err) => {
			if (abortController.signal.aborted) return;
			logger.error("Claude Code streaming error:", err);
			this.emitter?.(clientId, {
				type: "error",
				properties: {
					sessionId,
					error: err instanceof Error ? err.message : String(err),
				},
			});
		});

		return { ack: true };
	}

	private async streamQuery(
		clientId: string,
		sessionId: string,
		q: Query,
	): Promise<void> {
		try {
			for await (const msg of q) {
				this.handleStreamMessage(clientId, sessionId, msg);
			}
		} finally {
			this.activeQuery = null;
			this.activeAbort = null;
			this.emitter?.(clientId, {
				type: "end",
				properties: { sessionId },
			});
		}
	}

	private handleStreamMessage(
		clientId: string,
		sessionId: string,
		msg: SDKMessage,
	): void {
		if (!this.emitter) return;

		if (msg.type === "assistant") {
			const content = msg.message?.content;
			if (Array.isArray(content)) {
				for (const b of content) {
					if (b.type === "text" && typeof b.text === "string") {
						this.emitter(clientId, {
							type: "token",
							properties: { sessionId, text: b.text },
						});
					}
				}
			}

			// Emit full message event
			const parts = parseAssistantContent(
				msg.message as unknown as ClaudeAssistantMessage,
			);
			const text = parts
				.filter((p) => p.type === "text")
				.map((p) => (p as { text: string }).text)
				.join("");

			this.emitter(clientId, {
				type: "message",
				properties: {
					id: msg.uuid,
					role: "assistant",
					text,
					timestamp: Date.now(),
					sessionId,
					parts,
				},
			});
		} else if (msg.type === "result") {
			this.emitter(clientId, {
				type: "end",
				properties: { sessionId },
			});
		}
	}

	async abort(
		clientId: string,
		sessionId: string,
	): Promise<Record<string, never>> {
		if (this.activeAbort) {
			this.activeAbort.abort();
			this.activeAbort = null;
		}
		if (this.activeQuery) {
			this.activeQuery.close();
			this.activeQuery = null;
		}
		this.emitter?.(clientId, {
			type: "end",
			properties: { sessionId },
		});
		return {};
	}

	async agents(_clientId: string) {
		return [];
	}

	async providers(): Promise<ProviderInfo> {
		return {
			providers: [{ id: "claude-code", name: "Claude Code" }],
			default: { provider: "claude-code" },
		};
	}

	async setAuth(
		_providerId: string,
		_key: string,
	): Promise<Record<string, never>> {
		throw new Error("Claude Code manages its own authentication");
	}

	async command(
		_sessionId: string,
		_command: string,
		_args: string,
	): Promise<{ result: unknown }> {
		throw new Error("Not supported by Claude Code backend");
	}

	async revert(
		_sessionId: string,
		_messageId: string,
	): Promise<Record<string, never>> {
		throw new Error("Not supported by Claude Code backend");
	}

	async unrevert(_sessionId: string): Promise<Record<string, never>> {
		throw new Error("Not supported by Claude Code backend");
	}

	async share(_sessionId: string): Promise<{ share: ShareInfo }> {
		throw new Error("Not supported by Claude Code backend");
	}

	async permissionReply(
		_sessionId: string,
		_permissionId: string,
		_response: "once" | "always" | "reject",
	): Promise<Record<string, never>> {
		throw new Error("Not supported by Claude Code backend");
	}
}

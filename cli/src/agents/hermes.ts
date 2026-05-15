import os from "node:os";
import path from "node:path";

import type * as acp from "@agentclientprotocol/sdk";
import type { AcpMessage, AcpMessagePart } from "@shellular/protocol";
import Database from "better-sqlite3";
import { nanoid } from "nanoid";

import { logger } from "@/logger";
import { BUILTIN_AGENT_DESCRIPTORS } from "./agents";
import { ACP } from "./base";
import { newAiSessionFromResponse } from "./events";

import type { LoadSessionResult } from "./types";

interface MessageRow {
	id: number;
	session_id: string;
	role: string;
	content: string | null;
	tool_call_id: string | null;
	tool_calls: string | null;
	tool_name: string | null;
	timestamp: number;
	token_count: number | null;
	finish_reason: string | null;
	reasoning: string | null;
	reasoning_content: string | null;
	reasoning_details: string | null;
	codex_reasoning_items: string | null;
	codex_message_items: string | null;
}

export class Hermes extends ACP {
	private dbPath = path.join(os.homedir(), ".hermes", "state.db");
	private db = new Database(this.dbPath);

	static create() {
		return new Hermes(BUILTIN_AGENT_DESCRIPTORS.hermes);
	}

	override async loadSession(
		params: acp.LoadSessionRequest,
		clientId?: string,
	): Promise<LoadSessionResult> {
		const result = await super.loadSession(params, clientId);
		if (result.messages.length > 0) {
			return result;
		}

		const rows = this.db
			.prepare<string, MessageRow>(
				"SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC",
			)
			.all(params.sessionId);

		const messages: AcpMessage[] = rows.map((row) => {
			const parts: AcpMessagePart[] = [];

			const reasoningText = row.reasoning_content ?? row.reasoning ?? null;
			if (reasoningText) {
				parts.push({
					type: "reasoning",
					content: reasoningText,
					summary: "Reasoning",
				});
			}

			if (row.content) {
				parts.push({ type: "text", text: row.content });
			}

			if (row.tool_calls) {
				try {
					const toolCalls = JSON.parse(row.tool_calls);
					const calls = Array.isArray(toolCalls) ? toolCalls : [toolCalls];
					for (const call of calls) {
						parts.push({
							id: call.id ?? row.tool_call_id ?? nanoid(),
							type: "tool_call",
							name: call.function?.name ?? call.name ?? row.tool_name ?? "tool",
							title: call.function?.name ?? call.name ?? row.tool_name,
							arguments:
								call.function?.arguments !== undefined
									? typeof call.function.arguments === "string"
										? call.function.arguments
										: JSON.stringify(call.function.arguments, null, 2)
									: call.arguments !== undefined
										? typeof call.arguments === "string"
											? call.arguments
											: JSON.stringify(call.arguments, null, 2)
										: undefined,
						});
					}
				} catch {
					logger.warn(
						`Failed to parse hermes tool_calls for message ${row.id}`,
					);
				}
			}

			return {
				id: String(row.id),
				role: row.role as "user" | "assistant",
				parts,
				timestamp: Math.round(row.timestamp * 1000),
			};
		});

		this.setSessionStore(params.sessionId, {
			session:
				this.getSession(params.sessionId) ??
				newAiSessionFromResponse(
					{ sessionId: params.sessionId },
					path.resolve(params.cwd),
					params.sessionId,
				),
			messages,
		});

		return { ...result, messages };
	}
}

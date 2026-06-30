import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	readSync,
	readdirSync,
	statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type { AcpAiSession, AcpMessage, AiSession } from "@shellular/protocol";
import { BUILTIN_AGENT_DESCRIPTORS } from "./agents";
import { ACP } from "./base";
import type { AcpTranscriptOptions } from "./events";
import { normalizeCodexUserReplayMessage } from "./replay-normalization";
import type { LoadSessionResult } from "./types";

const CODEX_FALLBACK_LIMIT = 200;
const CODEX_SESSION_SCAN_LIMIT = 500;
const FIRST_LINE_MAX_BYTES = 512 * 1024;

type CodexIndexEntry = {
	id: string;
	thread_name?: string;
	updated_at?: string;
};

type CodexSessionMeta = {
	cwd?: string;
	createdAt?: number;
	model?: string;
};

type CodexResponseItem = {
	type?: unknown;
	role?: unknown;
	content?: unknown;
	call_id?: unknown;
	name?: unknown;
	arguments?: unknown;
	output?: unknown;
};

type StoreReplaySession = (
	session: AcpAiSession,
	messages: AcpMessage[],
) => void;

export class Codex extends ACP {
	static create() {
		return new Codex(BUILTIN_AGENT_DESCRIPTORS.codex);
	}

	override async listAiSessions(cwd?: string) {
		const sessions = await super.listAiSessions(cwd);
		return mergeCodexDesktopSessions(sessions, cwd);
	}

	override async listAiSessionsPage(cwd?: string, cursor?: string) {
		const result = await super.listAiSessionsPage(cwd, cursor);
		if (cursor) return result;
		return {
			...result,
			sessions: mergeCodexDesktopSessions(result.sessions, cwd),
		};
	}

	override async loadSession(
		params: acp.LoadSessionRequest,
		clientId?: string,
	): Promise<LoadSessionResult> {
		try {
			const result = await super.loadSession(params, clientId);
			if (result.messages.length > 0) return result;
			return (
				withCodexDesktopReplay(
					params,
					result,
					this.getSession(params.sessionId),
					(session, messages) =>
						this.setSessionStore(params.sessionId, { session, messages }),
				) ?? result
			);
		} catch (err) {
			const fallback = codexDesktopReplayResult(params, (session, messages) =>
				this.setSessionStore(params.sessionId, { session, messages }),
			);
			if (fallback) return fallback;
			throw err;
		}
	}

	override getMessages(sessionId: string) {
		const messages = super.getMessages(sessionId);
		return messages.length > 0 ? messages : readCodexDesktopMessages(sessionId);
	}

	protected override transcriptOptions(): AcpTranscriptOptions {
		return {
			normalizeUserReplayMessage: normalizeCodexUserReplayMessage,
		};
	}
}

function codexHome() {
	const fromEnv = process.env.CODEX_HOME;
	return fromEnv?.trim()
		? path.resolve(fromEnv.trim())
		: path.resolve(os.homedir(), ".codex");
}

function mergeCodexDesktopSessions(
	sessions: AiSession[],
	cwd?: string,
): AiSession[] {
	const fallback = readCodexDesktopSessions(cwd);
	if (fallback.length === 0) return sessions;
	const seen = new Set(sessions.map((session) => session.id).filter(Boolean));
	const merged = [...sessions];
	for (const session of fallback) {
		if (session.id && seen.has(session.id)) continue;
		merged.push(session);
		if (session.id) seen.add(session.id);
	}
	return merged.sort((a, b) => b.updatedAt - a.updatedAt);
}

function readCodexDesktopSessions(cwd?: string): AiSession[] {
	const home = codexHome();
	const indexPath = path.join(home, "session_index.jsonl");
	if (!existsSync(indexPath)) return [];

	const workspace = cwd ? path.resolve(cwd) : undefined;
	const sessionFiles = collectCodexSessionFiles(path.join(home, "sessions"));
	const entries = readCodexIndex(indexPath).slice(0, CODEX_FALLBACK_LIMIT);
	const sessions: AiSession[] = [];
	const seen = new Set<string>();

	for (const entry of entries) {
		if (seen.has(entry.id)) continue;
		const filePath = sessionFiles.get(entry.id);
		const meta = filePath ? readCodexSessionMeta(filePath) : {};
		if (workspace && (!meta.cwd || path.resolve(meta.cwd) !== workspace)) {
			continue;
		}
		seen.add(entry.id);
		const updatedAt = parseTime(entry.updated_at) ?? Date.now();
		sessions.push({
			id: entry.id,
			title: entry.thread_name || "Untitled Chat",
			createdAt: meta.createdAt ?? updatedAt,
			updatedAt,
			model: meta.model,
			workspacePath: meta.cwd,
		});
	}

	return sessions;
}

function withCodexDesktopReplay(
	params: acp.LoadSessionRequest,
	result: LoadSessionResult,
	existing: AcpAiSession | null,
	store: StoreReplaySession,
): LoadSessionResult | null {
	const messages = readCodexDesktopMessages(params.sessionId);
	if (messages.length === 0) return null;
	store(
		existing ??
			({
				id: params.sessionId,
				title: "Untitled Chat",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				workspacePath: path.resolve(params.cwd),
				configOptions: result.response.configOptions ?? [],
			} satisfies AcpAiSession),
		messages,
	);
	return { ...result, messages };
}

function codexDesktopReplayResult(
	params: acp.LoadSessionRequest,
	store: StoreReplaySession,
): LoadSessionResult | null {
	const messages = readCodexDesktopMessages(params.sessionId);
	if (messages.length === 0) return null;
	const session = readCodexDesktopSessions().find(
		(item) => item.id === params.sessionId,
	);
	store(
		{
			id: params.sessionId,
			title: session?.title ?? "Untitled Chat",
			createdAt: session?.createdAt ?? Date.now(),
			updatedAt: session?.updatedAt ?? Date.now(),
			workspacePath: session?.workspacePath ?? path.resolve(params.cwd),
			model: session?.model,
			configOptions: [],
		},
		messages,
	);
	return {
		response: { configOptions: [] } as acp.LoadSessionResponse,
		updates: [],
		messages,
	};
}

function readCodexIndex(indexPath: string): CodexIndexEntry[] {
	try {
		return readFileSync(indexPath, "utf8")
			.split("\n")
			.reverse()
			.flatMap((line) => {
				const parsed = safeJson(line) as Partial<CodexIndexEntry> | undefined;
				if (typeof parsed?.id !== "string") return [];
				return [
					{
						id: parsed.id,
						thread_name:
							typeof parsed.thread_name === "string"
								? parsed.thread_name
								: undefined,
						updated_at:
							typeof parsed.updated_at === "string"
								? parsed.updated_at
								: undefined,
					},
				];
			});
	} catch {
		return [];
	}
}

function collectCodexSessionFiles(root: string): Map<string, string> {
	const files: { filePath: string; mtime: number }[] = [];
	const walk = (dir: string, depth: number) => {
		if (depth > 5 || files.length > CODEX_SESSION_SCAN_LIMIT * 2) return;
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full, depth + 1);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				try {
					files.push({ filePath: full, mtime: statSync(full).mtimeMs });
				} catch {
					// ignore unreadable files
				}
			}
		}
	};
	walk(root, 0);

	const result = new Map<string, string>();
	for (const { filePath } of files
		.sort((a, b) => b.mtime - a.mtime)
		.slice(0, CODEX_SESSION_SCAN_LIMIT)) {
		const id = codexIdFromFilename(filePath);
		if (id && !result.has(id)) result.set(id, filePath);
	}
	return result;
}

function codexSessionFile(sessionId: string): string | undefined {
	return collectCodexSessionFiles(path.join(codexHome(), "sessions")).get(
		sessionId,
	);
}

function readCodexDesktopMessages(sessionId: string): AcpMessage[] {
	const filePath = codexSessionFile(sessionId);
	if (!filePath) return [];
	const messages: AcpMessage[] = [];
	const toolMessageByCallId = new Map<string, AcpMessage>();

	try {
		for (const line of readFileSync(filePath, "utf8").split("\n")) {
			const parsed = safeJson(line);
			if (parsed?.type !== "response_item") continue;
			const payload = parsed.payload as CodexResponseItem | undefined;
			if (!payload) continue;

			if (payload.type === "message") {
				const role =
					payload.role === "user" || payload.role === "assistant"
						? payload.role
						: null;
				if (!role) continue;
				const text = extractCodexContentText(payload.content);
				if (!text || shouldSkipCodexReplayText(role, text)) continue;
				messages.push({
					id: messageId(sessionId, messages.length),
					role,
					parts: [{ type: "text", text }],
					timestamp: parseTime(parsed.timestamp),
				});
				continue;
			}

			if (payload.type === "function_call") {
				const callId =
					typeof payload.call_id === "string"
						? payload.call_id
						: messageId(sessionId, messages.length);
				const message: AcpMessage = {
					id: messageId(sessionId, messages.length),
					role: "assistant",
					parts: [
						{
							id: callId,
							type: "tool_call",
							name:
								typeof payload.name === "string"
									? payload.name
									: "tool",
							arguments:
								typeof payload.arguments === "string"
									? payload.arguments
									: undefined,
							status: "completed",
						},
					],
					timestamp: parseTime(parsed.timestamp),
				};
				messages.push(message);
				toolMessageByCallId.set(callId, message);
				continue;
			}

			if (
				payload.type === "function_call_output" &&
				typeof payload.call_id === "string"
			) {
				const message = toolMessageByCallId.get(payload.call_id);
				const part = message?.parts[0];
				if (part?.type === "tool_call") {
					part.output =
						typeof payload.output === "string"
							? truncateReplayOutput(payload.output)
							: undefined;
				}
			}
		}
	} catch {
		return [];
	}

	return messages;
}

function messageId(sessionId: string, index: number): string {
	return `${sessionId}:codex-replay:${index}`;
}

function extractCodexContentText(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const text = content
		.flatMap((part) => {
			if (!part || typeof part !== "object") return [];
			const typed = part as { type?: unknown; text?: unknown };
			if (
				typed.type === "input_text" ||
				typed.type === "output_text" ||
				typed.type === "text"
			) {
				return typeof typed.text === "string" ? [typed.text] : [];
			}
			return [];
		})
		.join("\n\n")
		.trim();
	return text || undefined;
}

function shouldSkipCodexReplayText(role: "user" | "assistant", text: string) {
	if (role === "assistant") return false;
	const trimmed = text.trim();
	return (
		trimmed.startsWith("<environment_context>") ||
		trimmed.startsWith("<user_instructions>") ||
		trimmed.startsWith("<permissions instructions>") ||
		trimmed.startsWith("<app-context>") ||
		trimmed.startsWith("<collaboration_mode>") ||
		trimmed.startsWith("<skills_instructions>") ||
		trimmed.startsWith("<plugins_instructions>") ||
		trimmed.startsWith("## Memory")
	);
}

function truncateReplayOutput(output: string): string {
	const max = 8_000;
	return output.length > max ? `${output.slice(0, max)}\n...` : output;
}

function readCodexSessionMeta(filePath: string): CodexSessionMeta {
	const firstLine = readFirstLineSync(filePath);
	const first = firstLine ? safeJson(firstLine) : undefined;
	const payload =
		first?.type === "session_meta"
			? (first.payload as Record<string, unknown> | undefined)
			: undefined;
	return {
		cwd: typeof payload?.cwd === "string" ? payload.cwd : undefined,
		createdAt: parseTime(payload?.timestamp),
		model: typeof payload?.model === "string" ? payload.model : undefined,
	};
}

function readFirstLineSync(filePath: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(filePath, "r");
		const buffer = Buffer.alloc(FIRST_LINE_MAX_BYTES);
		const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
		const text = buffer.subarray(0, bytesRead).toString("utf8");
		const newline = text.indexOf("\n");
		return newline === -1 ? text : text.slice(0, newline);
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function safeJson(line: string): Record<string, unknown> | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	try {
		const parsed = JSON.parse(trimmed);
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function parseTime(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value < 1e12 ? value * 1000 : value;
	}
	if (typeof value !== "string") return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function codexIdFromFilename(filePath: string): string | undefined {
	const base = path.basename(filePath, ".jsonl");
	return base.match(
		/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
	)?.[0];
}

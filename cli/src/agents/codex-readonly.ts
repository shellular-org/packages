import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type * as acp from "@agentclientprotocol/sdk";

const READ_TIMEOUT_MS = 30_000;

interface CodexUserInput {
	type?: unknown;
	text?: unknown;
}

interface CodexThread {
	turns?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function threadFromResponse(value: unknown): CodexThread | undefined {
	if (!isRecord(value) || !isRecord(value.result)) return undefined;
	return isRecord(value.result.thread)
		? { turns: value.result.thread.turns }
		: undefined;
}

function errorDetails(value: unknown): string | undefined {
	if (!isRecord(value) || !isRecord(value.data)) return undefined;
	return stringValue(value.data.details);
}

export function isCodexActiveWriterError(error: unknown): boolean {
	if (
		error instanceof Error &&
		error.message.includes("already has an active writer")
	) {
		return true;
	}
	if (!isRecord(error)) return false;
	const message = stringValue(error.message);
	const details = errorDetails(error);
	return [message, details].some(
		(value) => value?.includes("already has an active writer") ?? false,
	);
}

/**
 * Read a Codex thread without resuming it.
 *
 * The ACP adapter currently implements session/load with thread/resume first.
 * That is correct for an idle thread, but Codex rejects it when the original
 * CLI still owns the thread's writer. app-server's thread/read is explicitly
 * read-only and works in both cases.
 */
export async function readCodexThread(
	command: string,
	sessionId: string,
	cwd: string,
): Promise<CodexThread> {
	const child = spawn(command, ["app-server", "--stdio"], {
		cwd,
		stdio: ["pipe", "pipe", "pipe"],
	});

	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000);
	});

	try {
		return await new Promise<CodexThread>((resolve, reject) => {
			const readline = createInterface({ input: child.stdout });
			let settled = false;
			const timeout = setTimeout(() => {
				finish(() =>
					reject(
						new Error(
							`Codex read-only thread request timed out after ${READ_TIMEOUT_MS}ms`,
						),
					),
				);
			}, READ_TIMEOUT_MS);

			const finish = (callback: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				readline.close();
				callback();
			};

			readline.on("line", (line) => {
				let message: unknown;
				try {
					message = JSON.parse(line);
				} catch {
					return;
				}

				if (!isRecord(message) || message.id !== 2) return;
				const error = message.error;
				if (isRecord(error)) {
					const details = errorDetails(error);
					finish(() =>
						reject(
							new Error(
								`${stringValue(error.message) ?? "Codex thread/read failed"}${details ? `: ${details}` : ""}`,
							),
						),
					);
					return;
				}

				const thread = threadFromResponse(message);
				if (!thread) {
					finish(() =>
						reject(new Error("Codex thread/read returned no thread")),
					);
					return;
				}
				finish(() => resolve(thread));
			});

			child.once("error", (error) => finish(() => reject(error)));
			child.once("exit", (code, signal) => {
				if (settled) return;
				const diagnostic = stderr.trim();
				finish(() =>
					reject(
						new Error(
							`Codex app-server exited before thread/read completed (${signal ?? `code ${code}`})${diagnostic ? `: ${diagnostic}` : ""}`,
						),
					),
				);
			});

			child.stdin.write(
				`${JSON.stringify({
					method: "initialize",
					id: 1,
					params: {
						clientInfo: {
							name: "shellular-readonly",
							version: "1.0.0",
						},
					},
				})}\n`,
			);
			child.stdin.write(
				`${JSON.stringify({ method: "initialized", params: {} })}\n`,
			);
			child.stdin.write(
				`${JSON.stringify({
					method: "thread/read",
					id: 2,
					params: { threadId: sessionId, includeTurns: true },
				})}\n`,
			);
		});
	} finally {
		child.kill();
	}
}

function textInput(input: unknown): string | null {
	if (!isRecord(input)) return null;
	const value: CodexUserInput = input;
	return value.type === "text" && typeof value.text === "string"
		? value.text
		: null;
}

function textList(value: unknown): string[] {
	if (typeof value === "string") return value ? [value] : [];
	if (!Array.isArray(value)) return [];
	return value.filter(
		(item): item is string => typeof item === "string" && item.length > 0,
	);
}

function notification(
	sessionId: string,
	update: acp.SessionNotification["update"],
): acp.SessionNotification {
	return { sessionId, update };
}

/** Convert the durable app-server thread projection into the ACP replay shape. */
export function codexThreadToSessionUpdates(
	sessionId: string,
	thread: CodexThread,
) {
	const updates: acp.SessionNotification[] = [];
	if (!Array.isArray(thread.turns)) return updates;

	for (const turn of thread.turns) {
		if (!isRecord(turn)) continue;
		const items = turn.items;
		if (!Array.isArray(items)) continue;

		for (const item of items) {
			if (!isRecord(item)) continue;
			const id = stringValue(item.id);

			switch (item.type) {
				case "userMessage": {
					if (!Array.isArray(item.content)) break;
					for (const input of item.content) {
						const text = textInput(input);
						if (text) {
							updates.push(
								notification(sessionId, {
									sessionUpdate: "user_message_chunk",
									messageId: id,
									content: { type: "text", text },
								}),
							);
						}
					}
					break;
				}
				case "agentMessage": {
					const text = stringValue(item.text);
					if (!text) break;
					updates.push(
						notification(sessionId, {
							sessionUpdate: "agent_message_chunk",
							messageId: id,
							content: { type: "text", text },
						}),
					);
					break;
				}
				case "reasoning": {
					for (const text of [
						...textList(item.summary),
						...textList(item.content),
					]) {
						updates.push(
							notification(sessionId, {
								sessionUpdate: "agent_thought_chunk",
								messageId: id,
								content: { type: "text", text },
							}),
						);
					}
					break;
				}
			}
		}
	}

	return updates;
}

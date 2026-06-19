import {
	existsSync,
	type FSWatcher,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	watch,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AiBackend, AiSessionRuntimeStatus } from "@shellular/protocol";

import { config } from "@/config";
import { logger } from "@/logger";

/**
 * Bridges agent "notify" hooks into Shellular so we can detect states that are
 * never written to the on-disk session logs — most importantly, a session that
 * is *waiting for permission*. The on-disk transcript goes silent while an
 * agent waits for approval, so file watching alone can't see it; the agent's
 * Notification hook can.
 *
 * Mechanism: a tiny helper script (installed to the Shellular dir) is registered
 * as the agent's hook. When the hook fires, the helper drops a small JSON file
 * into the watched notify dir. This process watches that dir and translates the
 * drops into runtime-state updates. A drop-file is used (rather than a socket)
 * so it works regardless of whether the CLI is running at hook time, and across
 * CLI restarts.
 */

export type NotifyEvent = {
	agentId: AiBackend;
	sessionId: string;
	status: AiSessionRuntimeStatus;
	message?: string;
	workspacePath?: string;
	updatedAt: number;
};

function homeSubdir(envVar: string, fallback: string): string {
	const fromEnv = process.env[envVar];
	if (fromEnv?.trim()) return path.resolve(fromEnv.trim());
	return path.resolve(os.homedir(), fallback);
}

const NOTIFY_DIR = path.join(config.SHELLULAR_DIR, "notify");
const HOOKS_DIR = path.join(config.SHELLULAR_DIR, "hooks");
const HELPER_PATH = path.join(HOOKS_DIR, "shellular-notify.mjs");
// Bump when the helper script body changes so installs refresh it.
const HELPER_VERSION = 1;

/**
 * Standalone helper invoked by an agent hook. It reads the hook's JSON payload
 * from stdin (Claude Code) or argv (Codex notify), normalizes it, and writes a
 * drop-file into the notify dir. It has no Shellular imports so it can run as a
 * bare node script from the agent process.
 */
const HELPER_SOURCE = `#!/usr/bin/env node
// shellular-notify helper v${HELPER_VERSION} — generated, do not edit.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const NOTIFY_DIR = ${JSON.stringify(NOTIFY_DIR)};
const agentArg = process.argv[2] || "";

function readStdin() {
	return new Promise((resolve) => {
		let data = "";
		if (process.stdin.isTTY) return resolve("");
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (c) => (data += c));
		process.stdin.on("end", () => resolve(data));
		process.stdin.on("error", () => resolve(data));
		setTimeout(() => resolve(data), 1000).unref?.();
	});
}

function safeJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function fromClaude(payload) {
	if (!payload || typeof payload !== "object") return undefined;
	const sessionId = payload.session_id;
	if (typeof sessionId !== "string") return undefined;
	const event = payload.hook_event_name;
	const ntype = payload.notification_type;
	const msg = typeof payload.message === "string" ? payload.message : "";
	// Claude's Notification hook fires for several reasons. ONLY a genuine
	// permission/approval prompt should map to waiting_for_permission. An
	// "idle" notification (Claude has been waiting for your input for a while)
	// is NOT a permission gate — the turn already finished — so reporting it as
	// "Permission" is a false positive. The notification_type field is the
	// authoritative discriminator; we additionally sniff the message text as a
	// fallback for Claude versions that don't set notification_type.
	const isPermission =
		ntype === "permission_prompt" ||
		ntype === "elicitation_dialog" ||
		(!ntype && /needs?\\s+your\\s+permission|permission to use|approve/i.test(msg));
	let status;
	let message;
	if (event === "Stop") {
		status = "finished";
		message = "Finished";
	} else if (isPermission) {
		status = "waiting_for_permission";
		message = "Waiting for permission";
	} else {
		// Idle / generic notification: the turn is done and Claude is waiting for
		// the user to type. Treat as finished, not as a permission prompt.
		return undefined;
	}
	return {
		agentId: "claude-code",
		sessionId,
		status,
		message,
		workspacePath: typeof payload.cwd === "string" ? payload.cwd : undefined,
		updatedAt: Date.now(),
	};
}

function fromCodex(payload, fallbackArg) {
	const data = payload ?? safeJson(fallbackArg);
	if (!data || typeof data !== "object") return undefined;
	// Codex notify currently only emits turn-complete; treat as finished.
	if (data.type && data.type !== "agent-turn-complete") return undefined;
	const sessionId = data["session-id"] || data.session_id || data["turn-id"];
	if (typeof sessionId !== "string") return undefined;
	return {
		agentId: "codex",
		sessionId,
		status: "finished",
		message: "Finished",
		updatedAt: Date.now(),
	};
}

async function main() {
	const stdin = await readStdin();
	const stdinJson = safeJson(stdin);
	// Codex passes JSON as argv[3]; Claude passes via stdin and agentArg is set
	// by our registration to "claude-code".
	const argJson = safeJson(process.argv[3] || "");
	let event;
	if (agentArg === "codex") {
		event = fromCodex(argJson, process.argv[3]);
	} else {
		event = fromClaude(stdinJson) ?? fromCodex(argJson, process.argv[3]);
	}
	if (!event) return;
	try {
		mkdirSync(NOTIFY_DIR, { recursive: true });
		const name = Date.now() + "-" + Math.random().toString(36).slice(2) + ".json";
		writeFileSync(path.join(NOTIFY_DIR, name), JSON.stringify(event));
	} catch {
		// best-effort; never block the agent
	}
}

main();
`;

export class NotifyBridge {
	private watcher?: FSWatcher;
	private started = false;

	constructor(private readonly onEvent: (event: NotifyEvent) => void) {}

	start() {
		if (this.started) return;
		this.started = true;
		try {
			mkdirSync(NOTIFY_DIR, { recursive: true });
			mkdirSync(HOOKS_DIR, { recursive: true });
		} catch (err) {
			logger.warn("NotifyBridge: failed to create dirs:", err);
			return;
		}
		this.installHelper();
		this.registerClaudeHooks();
		this.drainExisting();
		this.watchDir();
	}

	private installHelper() {
		try {
			const existing = existsSync(HELPER_PATH)
				? readFileSync(HELPER_PATH, "utf8")
				: undefined;
			if (existing !== HELPER_SOURCE) {
				writeFileSync(HELPER_PATH, HELPER_SOURCE, { mode: 0o755 });
			}
		} catch (err) {
			logger.warn("NotifyBridge: failed to install helper:", err);
		}
	}

	/**
	 * Idempotently registers the helper into ~/.claude/settings.json under the
	 * Notification (permission/idle) and Stop (finished) hooks. Additive: it
	 * preserves any hooks the user already configured.
	 */
	private registerClaudeHooks() {
		const settingsPath = path.join(
			homeSubdir("CLAUDE_CONFIG_DIR", ".claude"),
			"settings.json",
		);
		try {
			if (!existsSync(path.dirname(settingsPath))) return;
			const raw = existsSync(settingsPath)
				? readFileSync(settingsPath, "utf8")
				: "{}";
			const settings = JSON.parse(raw || "{}") as Record<string, unknown>;
			const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
			// Quote both the node binary and the script path so paths with spaces
			// (common on Windows) work. Use the current node executable rather than
			// relying on `node` being on the hook's PATH.
			const command = `"${process.execPath}" "${HELPER_PATH}" claude-code`;

			const changed =
				this.ensureClaudeHook(hooks, "Notification", command, "*") ||
				this.ensureClaudeHook(hooks, "Stop", command, undefined);
			if (!changed) return;
			settings.hooks = hooks;
			writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
			logger.debug("NotifyBridge: registered Claude Code hooks");
		} catch (err) {
			logger.warn("NotifyBridge: failed to register Claude hooks:", err);
		}
	}

	private ensureClaudeHook(
		hooks: Record<string, unknown>,
		event: string,
		command: string,
		matcher: string | undefined,
	): boolean {
		const list = Array.isArray(hooks[event])
			? (hooks[event] as Record<string, unknown>[])
			: [];
		const alreadyPresent = list.some((entry) => {
			const inner = entry?.hooks;
			return (
				Array.isArray(inner) &&
				inner.some(
					(h) =>
						h &&
						typeof h === "object" &&
						typeof (h as { command?: unknown }).command === "string" &&
						(h as { command: string }).command.includes(HELPER_PATH),
				)
			);
		});
		if (alreadyPresent) return false;
		const group: Record<string, unknown> = {
			hooks: [{ type: "command", command }],
		};
		if (matcher !== undefined) group.matcher = matcher;
		list.push(group);
		hooks[event] = list;
		return true;
	}

	private watchDir() {
		try {
			this.watcher = watch(NOTIFY_DIR, (_event, filename) => {
				if (!filename) return;
				this.consume(path.join(NOTIFY_DIR, filename.toString()));
			});
			this.watcher.on("error", (err) =>
				logger.warn("NotifyBridge watch error:", err),
			);
		} catch (err) {
			logger.warn("NotifyBridge: failed to watch notify dir:", err);
		}
	}

	private drainExisting() {
		let entries: string[] = [];
		try {
			entries = readdirSync(NOTIFY_DIR);
		} catch {
			return;
		}
		for (const name of entries) {
			this.consume(path.join(NOTIFY_DIR, name));
		}
	}

	private consume(filePath: string) {
		if (!filePath.endsWith(".json")) return;
		let event: NotifyEvent | undefined;
		try {
			const raw = readFileSync(filePath, "utf8");
			const parsed = JSON.parse(raw) as NotifyEvent;
			if (parsed?.agentId && parsed.sessionId && parsed.status) {
				event = { ...parsed, updatedAt: parsed.updatedAt ?? Date.now() };
			}
		} catch {
			// File may still be mid-write; the watcher will fire again on close.
			return;
		} finally {
			try {
				rmSync(filePath, { force: true });
			} catch {
				// ignore
			}
		}
		if (event) this.onEvent(event);
	}

	destroy() {
		this.started = false;
		try {
			this.watcher?.close();
		} catch {
			// ignore
		}
		this.watcher = undefined;
	}
}

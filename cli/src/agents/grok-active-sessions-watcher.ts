import { existsSync, type FSWatcher, readFileSync, watch } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentId } from "@shellular/protocol";

import { logger } from "@/logger";

/**
 * Watches Grok Build's `~/.grok/active_sessions.json`, the file it maintains
 * listing the sessions currently open in a `grok` CLI process. Each entry looks
 * like:
 *
 *   { "session_id": "...", "pid": 30272, "cwd": "/path", "opened_at": "..." }
 *
 * Unlike the Claude/Codex `SessionWatcher` (which tails jsonl logs to derive a
 * working/finished lifecycle), Grok hands us presence directly: an entry means
 * the session's CLI is open, its removal means the CLI closed. So this watcher
 * is deliberately minimal — it diffs the file on each change and reports adds
 * and removes. It does not attempt to infer whether a session is actively
 * working (Grok's ACP notifications / the notify bridge cover that when the
 * session is attached).
 */

export type GrokActiveSession = {
	sessionId: string;
	cwd: string;
	/** `opened_at` parsed to epoch ms, or the file's discovery time. */
	updatedAt: number;
};

const DEBOUNCE_MS = 300;
// fs.watch on a single file can miss atomic-rename writes (Grok writes via a
// temp file + rename); poll as a safety net so we still notice changes.
const POLL_INTERVAL_MS = 5 * 1000;

/** Path to Grok's active-sessions manifest. */
export function grokActiveSessionsPath(): string {
	return path.join(os.homedir(), ".grok", "active_sessions.json");
}

function parseOpenedAt(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** Parse `active_sessions.json` into a map keyed by session id. */
export function parseGrokActiveSessions(
	raw: string,
	now = Date.now(),
): Map<string, GrokActiveSession> {
	const sessions = new Map<string, GrokActiveSession>();
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return sessions;
	}
	if (!Array.isArray(data)) return sessions;

	for (const entry of data) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		const sessionId = record.session_id;
		const cwd = record.cwd;
		if (typeof sessionId !== "string" || !sessionId) continue;
		if (typeof cwd !== "string" || !cwd) continue;
		sessions.set(sessionId, {
			sessionId,
			cwd: path.resolve(cwd),
			updatedAt: parseOpenedAt(record.opened_at) ?? now,
		});
	}
	return sessions;
}

/**
 * Minimal file watcher for Grok's `active_sessions.json`. Emits `onAdd` for each
 * session that appears and `onRemove` for each that disappears, diffing against
 * the previously-seen set.
 */
export class GrokActiveSessionsWatcher {
	private readonly agentId: AgentId = "grok-build";
	private watcher?: FSWatcher;
	private pollTimer?: ReturnType<typeof setInterval>;
	private debounceTimer?: ReturnType<typeof setTimeout>;
	private started = false;
	// Sessions we've reported as active, so we can diff on each change.
	private active = new Map<string, GrokActiveSession>();

	constructor(
		private readonly onAdd: (session: GrokActiveSession) => void,
		private readonly onRemove: (agentId: AgentId, sessionId: string) => void,
	) {}

	start() {
		if (this.started) return;
		this.started = true;

		// Watch the containing directory rather than the file itself: fs.watch on a
		// path that's replaced via rename stops firing, whereas the parent dir keeps
		// reporting the rename. The dir (`~/.grok`) always exists once Grok has run.
		const filePath = grokActiveSessionsPath();
		const dir = path.dirname(filePath);
		const base = path.basename(filePath);
		if (existsSync(dir)) {
			try {
				this.watcher = watch(dir, (_event, filename) => {
					if (filename && filename.toString() !== base) return;
					this.scheduleReconcile();
				});
				this.watcher.on("error", (err) => {
					logger.warn("GrokActiveSessionsWatcher watch error:", err);
				});
			} catch (err) {
				logger.warn("GrokActiveSessionsWatcher failed to watch:", err);
			}
		}

		// Poll as a safety net for missed rename events.
		this.pollTimer = setInterval(() => this.reconcile(), POLL_INTERVAL_MS);
		this.pollTimer.unref?.();

		// Seed from whatever is present right now.
		this.reconcile();
	}

	private scheduleReconcile() {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = undefined;
			this.reconcile();
		}, DEBOUNCE_MS);
		this.debounceTimer.unref?.();
	}

	private reconcile() {
		const filePath = grokActiveSessionsPath();
		let next: Map<string, GrokActiveSession>;
		if (!existsSync(filePath)) {
			next = new Map();
		} else {
			try {
				next = parseGrokActiveSessions(readFileSync(filePath, "utf8"));
			} catch (err) {
				// A transient read error (mid-write) shouldn't wipe the active set;
				// leave it as-is and pick up the change on the next event/poll.
				logger.debug("GrokActiveSessionsWatcher read failed:", err);
				return;
			}
		}

		// Removed: present before, gone now.
		for (const sessionId of this.active.keys()) {
			if (!next.has(sessionId)) {
				this.onRemove(this.agentId, sessionId);
			}
		}
		// Added: present now, new to us.
		for (const [sessionId, session] of next) {
			if (!this.active.has(sessionId)) {
				this.onAdd(session);
			}
		}

		this.active = next;
	}

	destroy() {
		this.started = false;
		if (this.watcher) {
			try {
				this.watcher.close();
			} catch {
				// ignore
			}
			this.watcher = undefined;
		}
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.pollTimer = undefined;
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = undefined;
		this.active.clear();
	}
}

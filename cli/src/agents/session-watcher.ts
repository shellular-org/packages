import {
	existsSync,
	type FSWatcher,
	readdirSync,
	statSync,
	watch,
} from "node:fs";
import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentId, AiSessionRuntimeStatus } from "@shellular/protocol";

import { logger } from "@/logger";
import { isAgentAliveInCwd, liveAgentCwds } from "./process-scanner";

/**
 * Watches the on-disk session logs that Claude Code and Codex write while the
 * user runs them directly in a terminal (outside of Shellular). It derives a
 * lightweight runtime state for each session so the app can surface "active",
 * "working", and "finished" sessions that Shellular never started.
 *
 * Surfacing gate: a session is surfaced if its log was appended to within
 * ACTIVE_WINDOW_MS (actively working/just finished), OR if it was touched
 * within DISCOVERY_WINDOW_MS (2h) and a live agent process exists in its
 * launch cwd (idle but CLI still open). Historical sessions beyond the
 * discovery window are never surfaced. Once surfaced, the session is tracked.
 *
 * Retention: a session that finished (authoritatively, via a Stop hook or
 * task_complete marker) is sticky — it stays until the user explicitly dismisses
 * it, even if the CLI closes, because the user needs to check the result. A
 * running/permission session that goes silent for KILL_CHECK_TIMEOUT_MS is
 * disambiguated with a cheap pgrep check: if the agent process is dead, the CLI
 * was killed/closed mid-turn → remove; if alive, the turn finished naturally →
 * decay to a sticky finished.
 *
 * Neither agent records permission/approval prompts to disk, so those are
 * handled separately by the notify bridge. This watcher only reports presence
 * and the working/finished lifecycle.
 */

export type ExternalSessionUpdate = {
	agentId: AgentId;
	sessionId: string;
	status: AiSessionRuntimeStatus;
	updatedAt: number;
	title?: string;
	/**
	 * The directory the session was launched from — the project the agent was
	 * started in. Derived from the launch record in the log (Claude's first cwd
	 * line, Codex's session_meta), never the agent's later drifting cwd. This is
	 * both the session's workspace and what session/load needs to locate it on
	 * disk, and it's the cwd we match against a live process.
	 */
	workspacePath?: string;
	message?: string;
	/**
	 * True when the finished/cancelled status came from an authoritative
	 * lifecycle marker (Codex task_complete/turn_aborted). Claude's log-based
	 * finished is never authoritative — only its Stop hook is (handled by the
	 * notify bridge). Authoritative finished sessions are sticky; non-
	 * authoritative ones are kill-checked after KILL_CHECK_TIMEOUT_MS.
	 */
	authoritativeFinished?: boolean;
};

type WatchTarget = {
	agentId: AgentId;
	/** Root directory to watch recursively. */
	root: string;
	/** Parse a single jsonl file into an update, or undefined to skip. */
	parse: (filePath: string) => Promise<ExternalSessionUpdate | undefined>;
};

const DEBOUNCE_MS = 300;
// A session whose log was appended to within this window is treated as actively
// "working" (vs finished). Sessions within this window are surfaced immediately
// at discovery without a process check.
const ACTIVE_WINDOW_MS = 30 * 1000;
// How long a non-authoritative running/finished session can be silent before we
// disambiguate "idle finished" from "killed" with a pgrep check.
const KILL_CHECK_TIMEOUT_MS = 60 * 1000;
// Bounding window for discoverFresh's safety-net scan and the surfacing gate.
// Sessions whose log was touched within this window but beyond ACTIVE_WINDOW_MS
// are surfaced only if a live agent process exists in their cwd (pgrep check).
// Beyond this window, sessions are considered historical and not surfaced.
const DISCOVERY_WINDOW_MS = 2 * 60 * 60 * 1000;
// How often we decay state, drop killed sessions, and re-discover missed files.
const DECAY_INTERVAL_MS = 10 * 1000;
// fs.watch recursive mode is only supported on macOS and Windows. On other
// platforms (Linux) we poll recent files instead, at this interval.
const POLL_INTERVAL_MS = 10 * 1000;
const SUPPORTS_RECURSIVE_WATCH =
	process.platform === "darwin" || process.platform === "win32";
// How many bytes to read from the tail of a log to find the latest event.
const TAIL_BYTES = 16 * 1024;
// On startup, only consider this many most-recently-modified files per agent.
// (We only surface ones with a live process, so this just bounds the scan.)
const SEED_LIMIT = 50;

function homeSubdir(envVar: string, fallback: string): string {
	const fromEnv = process.env[envVar];
	if (fromEnv?.trim()) return path.resolve(fromEnv.trim());
	return path.resolve(os.homedir(), fallback);
}

function statusLabel(status: AiSessionRuntimeStatus): string {
	switch (status) {
		case "running":
			return "Working";
		case "finished":
			return "Finished";
		case "cancelled":
			return "Cancelled";
		case "error":
			return "Error";
		default:
			return "";
	}
}

function safeParseJson(line: string): Record<string, unknown> | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	try {
		const value = JSON.parse(trimmed);
		return value && typeof value === "object"
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function parseTimestamp(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		// Codex task_complete uses unix seconds; jsonl timestamps use ms ISO.
		return value < 1e12 ? value * 1000 : value;
	}
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

// Codex session_meta lines embed large base_instructions, so the first line can
// be far bigger than a tail window. Grow the read until a newline is found.
const FIRST_LINE_MAX_BYTES = 512 * 1024;

async function readFirstLine(filePath: string): Promise<string | undefined> {
	const handle = await open(filePath, "r");
	try {
		let offset = 0;
		let acc = "";
		while (offset < FIRST_LINE_MAX_BYTES) {
			const buffer = Buffer.alloc(TAIL_BYTES);
			const { bytesRead } = await handle.read(buffer, 0, TAIL_BYTES, offset);
			if (bytesRead <= 0) break;
			acc += buffer.subarray(0, bytesRead).toString("utf8");
			const newline = acc.indexOf("\n");
			if (newline !== -1) return acc.slice(0, newline);
			offset += bytesRead;
		}
		return acc || undefined;
	} finally {
		await handle.close();
	}
}

/** Reads the last complete non-empty line of a jsonl file. */
async function readLastLine(
	filePath: string,
	size: number,
): Promise<string | undefined> {
	if (size <= 0) return undefined;
	const handle = await open(filePath, "r");
	try {
		const start = Math.max(0, size - TAIL_BYTES);
		const length = size - start;
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, start);
		const text = buffer.subarray(0, bytesRead).toString("utf8");
		const lines = text.split("\n").filter((line) => line.trim().length > 0);
		// If we started mid-file, the first retained line may be partial; drop it.
		if (start > 0 && lines.length > 1) lines.shift();
		return lines.length ? lines[lines.length - 1] : undefined;
	} finally {
		await handle.close();
	}
}

// ─── Claude Code ──────────────────────────────────────────────────────────────
// ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
// The file basename is the sessionId. Each line carries `cwd`; an `ai-title`
// line carries the title. The session is "working" when the file was just
// written and the tail shows an in-progress turn (assistant tool_use, or a
// trailing tool_result), otherwise "finished".

async function parseClaudeSession(
	filePath: string,
): Promise<ExternalSessionUpdate | undefined> {
	if (!filePath.endsWith(".jsonl")) return undefined;
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(filePath);
	} catch {
		return undefined;
	}
	const sessionId = path.basename(filePath, ".jsonl");
	if (!sessionId) return undefined;

	const firstLine = await readFirstLine(filePath);
	const lastLine = await readLastLine(filePath, stat.size);
	const first = firstLine ? safeParseJson(firstLine) : undefined;
	const last = lastLine ? safeParseJson(lastLine) : undefined;

	// Skip empty sessions: a log with no user or assistant turn is a session that
	// was opened but never used (e.g. the user ran /resume and cancelled, leaving
	// only mode/permission/command metadata). Surfacing these as "active" is noise
	// — there is nothing to hand off to.
	if (!(await claudeHasConversation(filePath, stat.size, last))) {
		return undefined;
	}

	const mtime = stat.mtimeMs;
	const lastTs = parseTimestamp(last?.timestamp) ?? mtime;
	const recentlyActive = Date.now() - mtime <= ACTIVE_WINDOW_MS;

	// Workspace = the first cwd recorded in the log (the launch dir), never the
	// last. The last cwd drifts as the agent `cd`s into subdirectories mid-
	// session, and a drifted path both mislabels the workspace and breaks
	// session/load (Claude locates the session by the project folder derived
	// from this cwd).
	const workspacePath =
		(typeof first?.cwd === "string" && first.cwd) ||
		(await readClaudeCwd(filePath, stat.size)) ||
		undefined;

	const status = recentlyActive
		? claudeTurnInProgress(last)
			? "running"
			: "finished"
		: "finished";

	return {
		agentId: "claude-code",
		sessionId,
		status,
		updatedAt: lastTs,
		workspacePath: workspacePath || undefined,
		message: statusLabel(status) || undefined,
	};
}

/**
 * True if a Claude log contains at least one real conversation turn (a `user` or
 * `assistant` line). Used to skip sessions that were opened but never used, whose
 * logs hold only setup metadata (mode/permission/command lines).
 *
 * A real session's last line is almost always a user/assistant/tool line, so the
 * already-read last line short-circuits the common case. Only when it isn't do we
 * scan the file — and a session with no conversation is tiny, so that scan reads
 * just a few hundred bytes. We still bound the read so a pathological metadata-
 * only log can't cost more than a tail.
 */
async function claudeHasConversation(
	filePath: string,
	size: number,
	last?: Record<string, unknown>,
): Promise<boolean> {
	if (last?.type === "user" || last?.type === "assistant") return true;
	if (size <= 0) return false;
	const handle = await open(filePath, "r");
	try {
		const length = Math.min(size, TAIL_BYTES * 8);
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, 0);
		const text = buffer.subarray(0, bytesRead).toString("utf8");
		for (const line of text.split("\n")) {
			if (!line.includes('"user"') && !line.includes('"assistant"')) continue;
			const parsed = safeParseJson(line);
			if (parsed?.type === "user" || parsed?.type === "assistant") return true;
		}
		return false;
	} catch {
		// On a read error, don't hide a possibly-real session.
		return true;
	} finally {
		await handle.close();
	}
}

function claudeTurnInProgress(last?: Record<string, unknown>): boolean {
	if (!last) return false;
	const type = last.type;
	const message = last.message as Record<string, unknown> | undefined;
	// An assistant line whose stop_reason is tool_use means the model is about
	// to (or is) running tools — i.e. mid-turn.
	if (type === "assistant" && message) {
		if (message.stop_reason === "tool_use") return true;
		// No stop_reason yet => still streaming.
		if (message.stop_reason == null) return true;
		return false;
	}
	// A trailing user/tool_result line means tools just ran and the model is
	// expected to respond next.
	if (type === "user" && message) {
		const content = message.content;
		if (Array.isArray(content)) {
			return content.some(
				(block) =>
					block &&
					typeof block === "object" &&
					(block as { type?: unknown }).type === "tool_result",
			);
		}
	}
	return false;
}

/** Finds the first `cwd` value in a Claude log (mode/title lines lack it). */
async function readClaudeCwd(
	filePath: string,
	size: number,
): Promise<string | undefined> {
	const handle = await open(filePath, "r");
	try {
		const length = Math.min(size, TAIL_BYTES * 4);
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, 0);
		const text = buffer.subarray(0, bytesRead).toString("utf8");
		for (const line of text.split("\n")) {
			if (!line.includes('"cwd"')) continue;
			const parsed = safeParseJson(line);
			if (parsed && typeof parsed.cwd === "string") return parsed.cwd;
		}
		return undefined;
	} catch {
		return undefined;
	} finally {
		await handle.close();
	}
}

// Claude rewrites the `ai-title` line repeatedly as the conversation evolves and
// the title can change, so the LATEST occurrence is the correct one — and it can
// be anywhere, including near the end of a large file. We scan from the tail for
// the last ai-title, growing the window if needed. As a fallback (e.g. a session
// too new to have an ai-title yet) we use the first user prompt.
const TITLE_TAIL_BYTES = 256 * 1024;
const TITLE_MAX_LEN = 120;

async function readClaudeTitle(
	filePath: string,
	size: number,
): Promise<string | undefined> {
	const handle = await open(filePath, "r");
	try {
		// Scan an increasing tail window for the most recent ai-title.
		for (let window = TITLE_TAIL_BYTES; ; window *= 4) {
			const start = Math.max(0, size - window);
			const length = size - start;
			const buffer = Buffer.alloc(length);
			const { bytesRead } = await handle.read(buffer, 0, length, start);
			const text = buffer.subarray(0, bytesRead).toString("utf8");
			const lines = text.split("\n");
			for (let i = lines.length - 1; i >= 0; i -= 1) {
				const line = lines[i];
				if (!line.includes("ai-title")) continue;
				const parsed = safeParseJson(line);
				if (parsed?.type === "ai-title" && typeof parsed.aiTitle === "string") {
					return parsed.aiTitle.slice(0, TITLE_MAX_LEN);
				}
			}
			if (start === 0 || window >= size) break;
		}
		// No ai-title yet: fall back to the first human prompt.
		return await readClaudeFirstPrompt(handle);
	} catch {
		return undefined;
	} finally {
		await handle.close();
	}
}

/** First user text prompt in a Claude log, used as a title fallback. */
async function readClaudeFirstPrompt(
	handle: Awaited<ReturnType<typeof open>>,
): Promise<string | undefined> {
	const buffer = Buffer.alloc(TAIL_BYTES * 8);
	const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
	const text = buffer.subarray(0, bytesRead).toString("utf8");
	for (const line of text.split("\n")) {
		if (!line.includes('"user"')) continue;
		const parsed = safeParseJson(line);
		if (parsed?.type !== "user") continue;
		const message = parsed.message as Record<string, unknown> | undefined;
		const prompt = extractUserText(message?.content);
		if (prompt) return prompt.slice(0, TITLE_MAX_LEN);
	}
	return undefined;
}

/** Pulls plain user text from a message content (string or content blocks). */
function extractUserText(content: unknown): string | undefined {
	if (typeof content === "string") {
		const trimmed = content.trim();
		return trimmed && !trimmed.startsWith("<") ? trimmed : undefined;
	}
	if (Array.isArray(content)) {
		for (const block of content) {
			if (
				block &&
				typeof block === "object" &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string"
			) {
				const text = (block as { text: string }).text.trim();
				if (text && !text.startsWith("<")) return text;
			}
		}
	}
	return undefined;
}

// ─── Codex ────────────────────────────────────────────────────────────────────
// ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl
// The session id lives in the first `session_meta` line's payload.id (and in the
// filename). Lifecycle is explicit: event_msg/task_started (running),
// task_complete (finished), turn_aborted (cancelled).

async function parseCodexSession(
	filePath: string,
): Promise<ExternalSessionUpdate | undefined> {
	if (!filePath.endsWith(".jsonl")) return undefined;
	if (!path.basename(filePath).startsWith("rollout-")) return undefined;
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(filePath);
	} catch {
		return undefined;
	}

	const firstLine = await readFirstLine(filePath);
	const first = firstLine ? safeParseJson(firstLine) : undefined;
	const meta =
		first?.type === "session_meta"
			? (first.payload as Record<string, unknown> | undefined)
			: undefined;
	const sessionId =
		(typeof meta?.id === "string" && meta.id) || codexIdFromFilename(filePath);
	if (!sessionId) return undefined;
	const workspacePath = typeof meta?.cwd === "string" ? meta.cwd : undefined;

	const lastEvent = await readCodexLastLifecycle(filePath, stat.size);
	const mtime = stat.mtimeMs;
	const recentlyActive = Date.now() - mtime <= ACTIVE_WINDOW_MS;

	let status: AiSessionRuntimeStatus;
	if (lastEvent?.type === "turn_aborted") {
		status = "cancelled";
	} else if (lastEvent?.type === "task_started" && recentlyActive) {
		status = "running";
	} else {
		status = "finished";
	}

	const title = await readCodexTitle(filePath, stat.size);

	return {
		agentId: "codex",
		sessionId,
		status,
		updatedAt: lastEvent?.timestamp ?? mtime,
		// session_meta.cwd is the launch dir. Later turn_context lines carry their
		// own (drifting) cwd, but we deliberately read only session_meta so the
		// workspace stays pinned to where the session was started.
		workspacePath,
		title,
		message: statusLabel(status) || undefined,
		authoritativeFinished:
			lastEvent?.type === "task_complete" || lastEvent?.type === "turn_aborted",
	};
}

// Codex has no title; use the first real user prompt (skipping the
// <environment_context> / <user_instructions> preambles it injects).
async function readCodexTitle(
	filePath: string,
	size: number,
): Promise<string | undefined> {
	const handle = await open(filePath, "r");
	try {
		const length = Math.min(size, TAIL_BYTES * 16);
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, 0);
		const text = buffer.subarray(0, bytesRead).toString("utf8");
		for (const line of text.split("\n")) {
			if (!line.includes("user_message") && !line.includes("input_text")) {
				continue;
			}
			const parsed = safeParseJson(line);
			const payload = parsed?.payload as Record<string, unknown> | undefined;
			if (!payload) continue;
			// event_msg/user_message carries the prompt as a plain string.
			if (
				payload.type === "user_message" &&
				typeof payload.message === "string"
			) {
				const text = payload.message.trim();
				if (text && !text.startsWith("<")) return text.slice(0, TITLE_MAX_LEN);
			}
			// response_item/message (role user) carries input_text content blocks.
			if (payload.type === "message" && payload.role === "user") {
				const prompt = extractCodexInputText(payload.content);
				if (prompt) return prompt.slice(0, TITLE_MAX_LEN);
			}
		}
		return undefined;
	} catch {
		return undefined;
	} finally {
		await handle.close();
	}
}

function extractCodexInputText(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		if (
			block &&
			typeof block === "object" &&
			(block as { type?: unknown }).type === "input_text" &&
			typeof (block as { text?: unknown }).text === "string"
		) {
			const text = (block as { text: string }).text.trim();
			if (text && !text.startsWith("<")) return text;
		}
	}
	return undefined;
}

function codexIdFromFilename(filePath: string): string | undefined {
	// rollout-2026-06-15T13-02-38-<uuid>.jsonl
	const base = path.basename(filePath, ".jsonl");
	const match = base.match(
		/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
	);
	return match?.[0];
}

/** Finds the most recent task lifecycle event by scanning the tail. */
async function readCodexLastLifecycle(
	filePath: string,
	size: number,
): Promise<{ type: string; timestamp?: number } | undefined> {
	if (size <= 0) return undefined;
	const handle = await open(filePath, "r");
	try {
		const start = Math.max(0, size - TAIL_BYTES);
		const length = size - start;
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, start);
		const text = buffer.subarray(0, bytesRead).toString("utf8");
		const lines = text.split("\n");
		let result: { type: string; timestamp?: number } | undefined;
		for (const line of lines) {
			if (
				!line.includes("task_started") &&
				!line.includes("task_complete") &&
				!line.includes("turn_aborted")
			) {
				continue;
			}
			const parsed = safeParseJson(line);
			if (parsed?.type !== "event_msg") continue;
			const payload = parsed.payload as Record<string, unknown> | undefined;
			const type = payload?.type;
			if (
				type === "task_started" ||
				type === "task_complete" ||
				type === "turn_aborted"
			) {
				result = {
					type,
					timestamp: parseTimestamp(parsed.timestamp),
				};
			}
		}
		return result;
	} catch {
		return undefined;
	} finally {
		await handle.close();
	}
}

// ─── Watcher ────────────────────────────────────────────────────────────────

type TrackedSession = {
	update: ExternalSessionUpdate;
	/** True once the session reached a definitive finished/cancelled state. */
	authoritativeFinished: boolean;
};

export class SessionWatcher {
	private watchers: FSWatcher[] = [];
	private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private decayTimer?: ReturnType<typeof setInterval>;
	private targets: WatchTarget[] = [];
	private started = false;
	// Sessions currently surfaced. Used to decay running -> finished, detect
	// killed CLIs, and keep finished sessions sticky until dismissed.
	private tracked = new Map<string, TrackedSession>();
	private pollTimer?: ReturnType<typeof setInterval>;
	// The file mtime we last processed per path during discovery (poll on Linux,
	// reconcile's discoverFresh everywhere), so we only re-parse files that
	// actually changed.
	private polledMtimes = new Map<string, number>();

	constructor(
		private readonly onUpdate: (update: ExternalSessionUpdate) => void,
		private readonly onRemove: (agentId: AgentId, sessionId: string) => void,
	) {}

	start() {
		if (this.started) return;
		this.started = true;

		this.targets = [
			{
				agentId: "claude-code",
				root: path.join(homeSubdir("CLAUDE_CONFIG_DIR", ".claude"), "projects"),
				parse: this.parseClaudeWithTitle,
			},
			{
				agentId: "codex",
				root: path.join(homeSubdir("CODEX_HOME", ".codex"), "sessions"),
				parse: parseCodexSession,
			},
		];

		for (const target of this.targets) {
			this.watchTarget(target);
		}
		this.seed();

		this.decayTimer = setInterval(() => {
			void this.reconcile();
		}, DECAY_INTERVAL_MS);
		this.decayTimer.unref?.();

		// Linux (and any platform without recursive fs.watch) has no live watch at
		// all, so it polls more frequently to notice new/changed session logs.
		// (Recursive-watch platforms still get periodic discovery via reconcile's
		// discoverFresh, as a safety net for missed watch events.)
		if (!SUPPORTS_RECURSIVE_WATCH) {
			this.pollTimer = setInterval(
				() => this.discoverFresh(),
				POLL_INTERVAL_MS,
			);
			this.pollTimer.unref?.();
		}
	}

	private parseClaudeWithTitle = async (
		filePath: string,
	): Promise<ExternalSessionUpdate | undefined> => {
		const update = await parseClaudeSession(filePath);
		if (!update) return undefined;
		try {
			const { size } = statSync(filePath);
			const title = await readClaudeTitle(filePath, size);
			if (title) update.title = title;
		} catch {
			// best-effort title
		}
		return update;
	};

	private watchTarget(target: WatchTarget) {
		if (!existsSync(target.root)) {
			logger.debug(`SessionWatcher: ${target.root} not present, skipping`);
			return;
		}
		// Without recursive watch (Linux), polling covers changes instead.
		if (!SUPPORTS_RECURSIVE_WATCH) return;
		try {
			const watcher = watch(
				target.root,
				{ recursive: true },
				(_event, filename) => {
					if (!filename) return;
					const filePath = path.resolve(target.root, filename.toString());
					if (!filePath.endsWith(".jsonl")) return;
					this.scheduleParse(target, filePath);
				},
			);
			watcher.on("error", (err) => {
				logger.warn(`SessionWatcher error for ${target.root}:`, err);
			});
			this.watchers.push(watcher);
			logger.debug(`SessionWatcher: watching ${target.root}`);
		} catch (err) {
			logger.warn(`SessionWatcher: failed to watch ${target.root}:`, err);
		}
	}

	private scheduleParse(target: WatchTarget, filePath: string) {
		const existing = this.debounceTimers.get(filePath);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => {
			this.debounceTimers.delete(filePath);
			void this.processFile(target, filePath);
		}, DEBOUNCE_MS);
		timer.unref?.();
		this.debounceTimers.set(filePath, timer);
	}

	private async processFile(
		target: WatchTarget,
		filePath: string,
		// The cwds of live agent processes, when the caller (proactive discovery)
		// has already enumerated them. If a session's launch cwd is in this set we
		// skip the per-file pgrep — this is what lets an idle-but-live session
		// surface without depending on a file event ever firing again.
		options: { liveCwds?: Set<string> } = {},
	) {
		try {
			const update = await target.parse(filePath);
			if (!update?.sessionId) return;
			const key = `${update.agentId}:${update.sessionId}`;
			const now = Date.now();

			// Surfacing gate for untracked sessions:
			// - Within ACTIVE_WINDOW_MS (30s): surface immediately — the session
			//   is actively working or just finished a turn.
			// - Between ACTIVE_WINDOW_MS and DISCOVERY_WINDOW_MS (2h): the session
			//   is idle but the CLI might still be open. Surface only if a live
			//   agent process exists in its launch cwd (known from liveCwds, else a
			//   cheap pgrep check).
			// - Beyond DISCOVERY_WINDOW_MS: historical, never surface.
			// Already-tracked sessions always get processed (new activity).
			if (!this.tracked.has(key)) {
				const age = now - update.updatedAt;
				if (age > DISCOVERY_WINDOW_MS) return;
				if (age > ACTIVE_WINDOW_MS) {
					const knownAlive =
						!!update.workspacePath &&
						options.liveCwds?.has(update.workspacePath) === true;
					if (
						!knownAlive &&
						!(await isAgentAliveInCwd(update.agentId, update.workspacePath))
					) {
						return;
					}
				}
			}

			// Title stickiness: title extraction can occasionally come back empty on
			// a given parse (e.g. ai-title not yet written, transient read). Never
			// let a later update drop a title we already had for this session, so the
			// app never flickers back to the raw id / "New Chat".
			if (!update.title) {
				const prev = this.tracked.get(key)?.update.title;
				if (prev) update.title = prev;
			}

			// Preserve authoritative-finished stickiness: once a session has been
			// marked authoritatively finished (e.g. Codex task_complete), a later
			// non-authoritative parse must not downgrade it.
			const prevTracked = this.tracked.get(key);
			const authoritative =
				update.authoritativeFinished ??
				prevTracked?.authoritativeFinished ??
				false;

			this.report(update, authoritative);
		} catch (err) {
			logger.debug(`SessionWatcher: parse failed for ${filePath}:`, err);
		}
	}

	private report(update: ExternalSessionUpdate, authoritative: boolean) {
		const key = `${update.agentId}:${update.sessionId}`;
		const previous = this.tracked.get(key);
		// Avoid spamming identical non-running states; only emit on change or while
		// running (so updatedAt stays fresh for recency filtering).
		if (
			previous &&
			previous.update.status === update.status &&
			update.status !== "running" &&
			previous.update.title === update.title &&
			previous.update.workspacePath === update.workspacePath &&
			previous.authoritativeFinished === authoritative
		) {
			return;
		}
		this.tracked.set(key, { update, authoritativeFinished: authoritative });
		this.onUpdate(update);
	}

	/**
	 * Periodic reconciliation: discover newly-touched session logs (safety net
	 * for missed fs.watch events), decay stale running -> finished, and detect
	 * killed CLIs. Authoritative-finished sessions are sticky and never removed
	 * here. Non-authoritative sessions that have been silent for
	 * KILL_CHECK_TIMEOUT_MS are disambiguated with a cheap pgrep check: alive →
	 * upgrade to sticky finished; dead → remove.
	 */
	private async reconcile() {
		const now = Date.now();
		this.discoverFresh();
		// Liveness-driven discovery: catch live-but-idle sessions that no file
		// event will re-surface. Best-effort — never let it block reconciliation.
		await this.discoverLiveSessions().catch((err) => {
			logger.debug("SessionWatcher: live discovery failed:", err);
		});
		for (const [key, session] of [...this.tracked.entries()]) {
			const { update, authoritativeFinished } = session;
			// Authoritative finished/cancelled/error: sticky until user dismisses.
			if (
				authoritativeFinished &&
				(update.status === "finished" ||
					update.status === "cancelled" ||
					update.status === "error")
			) {
				continue;
			}

			const quietMs = now - update.updatedAt;

			// Running session that went quiet: decay to finished. If it stays
			// quiet past KILL_CHECK_TIMEOUT_MS, the reconcile below will pgrep.
			if (update.status === "running" && quietMs > ACTIVE_WINDOW_MS) {
				const finished: ExternalSessionUpdate = {
					...update,
					status: "finished",
					message: statusLabel("finished"),
					updatedAt: update.updatedAt,
				};
				this.tracked.set(key, {
					update: finished,
					authoritativeFinished: false,
				});
				this.onUpdate(finished);
				continue;
			}

			// Non-authoritative finished or waiting-for-permission, silent long
			// enough to suspect the CLI was killed: disambiguate with pgrep.
			if (quietMs <= KILL_CHECK_TIMEOUT_MS) continue;
			if (
				update.status === "waiting_for_permission" ||
				update.status === "running"
			) {
				const alive = await isAgentAliveInCwd(
					update.agentId,
					update.workspacePath,
				);
				if (alive) {
					// Process still running — the turn ended but the CLI is open.
					// Upgrade to sticky finished so we don't keep re-checking.
					const finished: ExternalSessionUpdate = {
						...update,
						status: "finished",
						message: statusLabel("finished"),
						updatedAt: update.updatedAt,
					};
					this.tracked.set(key, {
						update: finished,
						authoritativeFinished: true,
					});
					this.onUpdate(finished);
				} else {
					// CLI was killed/closed — remove the session.
					this.tracked.delete(key);
					this.onRemove(update.agentId, update.sessionId);
				}
				continue;
			}

			// Non-authoritative finished, silent past kill-check timeout: the CLI
			// is probably gone. Disambiguate with pgrep; if alive, upgrade to
			// sticky so we stop checking.
			if (update.status === "finished") {
				const alive = await isAgentAliveInCwd(
					update.agentId,
					update.workspacePath,
				);
				if (alive) {
					this.tracked.set(key, {
						update,
						authoritativeFinished: true,
					});
				} else {
					this.tracked.delete(key);
					this.onRemove(update.agentId, update.sessionId);
				}
			}
		}
	}

	private seed() {
		for (const target of this.targets) {
			if (!existsSync(target.root)) continue;
			const files = this.recentFiles(target.root, SEED_LIMIT);
			for (const filePath of files) {
				void this.processFile(target, filePath);
			}
		}
	}

	/**
	 * Re-scans recently-modified logs and re-parses any whose mtime changed since
	 * we last saw them. This is the discovery safety net (see reconcile): it runs
	 * on every platform and catches sessions that fs.watch missed — most notably a
	 * resumed session that appends to its original, older log file. Bounded to
	 * files modified within the freshness window so it stays cheap (a stat per
	 * candidate, then a parse only when something actually changed).
	 */
	private discoverFresh() {
		const now = Date.now();
		for (const target of this.targets) {
			if (!existsSync(target.root)) continue;
			for (const filePath of this.recentFiles(target.root, SEED_LIMIT)) {
				let mtime: number;
				try {
					mtime = statSync(filePath).mtimeMs;
				} catch {
					continue;
				}
				// Only files touched within the discovery window can hold a live or
				// recently-active session; skip the rest so we don't re-parse history.
				if (now - mtime > DISCOVERY_WINDOW_MS) continue;
				if (this.polledMtimes.get(filePath) === mtime) continue;
				this.polledMtimes.set(filePath, mtime);
				void this.processFile(target, filePath);
			}
		}
	}

	/**
	 * Proactively discovers sessions whose CLI is still running but whose log has
	 * gone idle. discoverFresh only re-parses files whose mtime *changed*, and
	 * fs.watch only fires on writes — so a session that finished a turn (with the
	 * CLI left open) is never re-examined and can be missed if its one surfacing
	 * check didn't happen at the right moment. Here liveness drives discovery
	 * instead of file writes: we enumerate live agent process cwds once, then
	 * surface any untracked recent log launched from one of those cwds. Cheap on
	 * idle machines — the pgrep short-circuits to an empty set when no agent runs.
	 */
	private async discoverLiveSessions() {
		const now = Date.now();
		for (const target of this.targets) {
			if (!existsSync(target.root)) continue;
			const liveCwds = await liveAgentCwds(target.agentId);
			if (liveCwds.size === 0) continue;
			for (const filePath of this.recentFiles(target.root, SEED_LIMIT)) {
				let mtime: number;
				try {
					mtime = statSync(filePath).mtimeMs;
				} catch {
					continue;
				}
				if (now - mtime > DISCOVERY_WINDOW_MS) continue;
				// Already-surfaced sessions are re-reported cheaply (report() dedupes),
				// so we only skip re-parsing when nothing about the file changed since
				// we last surfaced it — the common idle case.
				if (this.tracked.has(this.trackedKeyForFile(target, filePath)))
					continue;
				void this.processFile(target, filePath, { liveCwds });
			}
		}
	}

	/**
	 * Derives a session's tracked-map key from its log filename without parsing —
	 * Claude's basename is the sessionId; Codex embeds the uuid in the filename
	 * (matching session_meta.id). Lets proactive discovery cheaply skip logs it
	 * has already surfaced. Returns "" when no id can be derived (never tracked).
	 */
	private trackedKeyForFile(target: WatchTarget, filePath: string): string {
		const sessionId =
			target.agentId === "codex"
				? codexIdFromFilename(filePath)
				: path.basename(filePath, ".jsonl");
		return sessionId ? `${target.agentId}:${sessionId}` : "";
	}

	/** Returns the most-recently-modified .jsonl files under root. */
	private recentFiles(root: string, limit: number): string[] {
		const collected: { path: string; mtime: number }[] = [];
		const walk = (dir: string, depth: number) => {
			if (depth > 6) return;
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
						collected.push({ path: full, mtime: statSync(full).mtimeMs });
					} catch {
						// ignore unreadable file
					}
				}
			}
		};
		walk(root, 0);
		return collected
			.sort((a, b) => b.mtime - a.mtime)
			.slice(0, limit)
			.map((item) => item.path);
	}

	destroy() {
		this.started = false;
		for (const watcher of this.watchers) {
			try {
				watcher.close();
			} catch {
				// ignore
			}
		}
		this.watchers = [];
		for (const timer of this.debounceTimers.values()) clearTimeout(timer);
		this.debounceTimers.clear();
		if (this.decayTimer) clearInterval(this.decayTimer);
		this.decayTimer = undefined;
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.pollTimer = undefined;
		this.polledMtimes.clear();
		this.tracked.clear();
	}
}

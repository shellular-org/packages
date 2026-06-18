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
import type { AiBackend, AiSessionRuntimeStatus } from "@shellular/protocol";

import { logger } from "@/logger";
import { ProcessScanner } from "./process-scanner";

/**
 * Watches the on-disk session logs that Claude Code and Codex write while the
 * user runs them directly in a terminal (outside of Shellular). It derives a
 * lightweight runtime state for each session so the app can surface "active",
 * "working", and "finished" sessions that Shellular never started.
 *
 * A session is only surfaced if a live agent process exists in its workspace
 * (see ProcessScanner). This gate is what keeps the home page to the sessions
 * the user actually has open right now — working OR finished — rather than every
 * historical log on disk. When the process exits, the session is removed.
 *
 * Neither agent records permission/approval prompts to disk, so those are
 * handled separately by the notify bridge. This watcher only reports presence
 * and the working/finished lifecycle.
 */

export type ExternalSessionUpdate = {
	agentId: AiBackend;
	sessionId: string;
	status: AiSessionRuntimeStatus;
	updatedAt: number;
	title?: string;
	workspacePath?: string;
	/**
	 * The directory the session was launched from. Stable for the session's
	 * lifetime, unlike workspacePath which follows the agent's current cwd as it
	 * `cd`s around. Used to match a session to its live process (whose cwd is the
	 * launch dir). Falls back to workspacePath when unknown.
	 */
	launchCwd?: string;
	message?: string;
};

type WatchTarget = {
	agentId: AiBackend;
	/** Root directory to watch recursively. */
	root: string;
	/** Parse a single jsonl file into an update, or undefined to skip. */
	parse: (filePath: string) => Promise<ExternalSessionUpdate | undefined>;
};

const DEBOUNCE_MS = 300;
// A session whose log was appended to within this window is treated as actively
// "working" (vs finished).
const ACTIVE_WINDOW_MS = 30 * 1000;
// A live agent process can share a cwd with many historical session logs. Only
// the session whose log was touched within this window is the one the process is
// actually using; older logs in the same cwd are stale and not surfaced. Kept
// generous so a session that finished a while ago (but whose CLI is still open)
// stays visible until you check it or the process exits.
const LIVE_SESSION_FRESHNESS_MS = 60 * 60 * 1000;
// How often we re-scan processes to decay state and drop exited sessions.
const DECAY_INTERVAL_MS = 10 * 1000;
// fs.watch recursive mode is only supported on macOS and Windows. On other
// platforms (Linux) we poll recent files instead, at this interval.
const POLL_INTERVAL_MS = 3 * 1000;
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

/** True if `parent` is the same dir as, or an ancestor of, `child`. */
function pathContains(parent: string, child: string): boolean {
	if (parent === child) return true;
	const base = parent.endsWith(path.sep) ? parent : parent + path.sep;
	return child.startsWith(base);
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

	const mtime = stat.mtimeMs;
	const lastTs = parseTimestamp(last?.timestamp) ?? mtime;
	const recentlyActive = Date.now() - mtime <= ACTIVE_WINDOW_MS;

	// Launch dir = the first cwd recorded in the log (before any `cd`); stable.
	const launchCwd =
		(typeof first?.cwd === "string" && first.cwd) ||
		(await readClaudeCwd(filePath, stat.size)) ||
		undefined;
	const workspacePath =
		(typeof last?.cwd === "string" && last.cwd) || launchCwd || undefined;

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
		launchCwd: launchCwd || undefined,
		message: statusLabel(status) || undefined,
	};
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
		workspacePath,
		// Codex records the launch cwd in session_meta and doesn't drift it.
		launchCwd: workspacePath,
		title,
		message: statusLabel(status) || undefined,
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

export class SessionWatcher {
	private watchers: FSWatcher[] = [];
	private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private decayTimer?: ReturnType<typeof setInterval>;
	private targets: WatchTarget[] = [];
	private started = false;
	// Sessions currently surfaced (had a live process). Used to decay running ->
	// finished, and to detect when a process exits so we can remove the session.
	private lastReported = new Map<string, ExternalSessionUpdate>();
	private scanner = new ProcessScanner();
	private pollTimer?: ReturnType<typeof setInterval>;
	// On poll-based platforms, the file mtime we last processed per path, so we
	// only re-parse files that actually changed.
	private polledMtimes = new Map<string, number>();

	constructor(
		private readonly onUpdate: (update: ExternalSessionUpdate) => void,
		private readonly onRemove: (agentId: AiBackend, sessionId: string) => void,
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

		// Linux (and any platform without recursive fs.watch) relies on polling to
		// notice new/changed session logs.
		if (!SUPPORTS_RECURSIVE_WATCH) {
			this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
			this.pollTimer.unref?.();
		}
	}

	/** Re-parses recently-modified files on platforms without recursive watch. */
	private poll() {
		for (const target of this.targets) {
			if (!existsSync(target.root)) continue;
			for (const filePath of this.recentFiles(target.root, SEED_LIMIT)) {
				let mtime: number;
				try {
					mtime = statSync(filePath).mtimeMs;
				} catch {
					continue;
				}
				if (this.polledMtimes.get(filePath) === mtime) continue;
				this.polledMtimes.set(filePath, mtime);
				void this.processFile(target, filePath);
			}
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

	private async processFile(target: WatchTarget, filePath: string) {
		try {
			const update = await target.parse(filePath);
			if (!update?.sessionId) return;
			const live = await this.hasLiveProcess(update);
			const key = `${update.agentId}:${update.sessionId}`;
			if (!live) {
				// No live process for this session's workspace. If we were showing it,
				// the process just exited — remove it; otherwise ignore the change.
				if (this.lastReported.has(key)) {
					this.lastReported.delete(key);
					this.onRemove(update.agentId, update.sessionId);
				}
				return;
			}
			// Title stickiness: title extraction can occasionally come back empty on
			// a given parse (e.g. ai-title not yet written, transient read). Never
			// let a later update drop a title we already had for this session, so the
			// app never flickers back to the raw id / "New Chat".
			if (!update.title) {
				const prevTitle = this.lastReported.get(key)?.title;
				if (prevTitle) update.title = prevTitle;
			}
			this.report(update);
		} catch (err) {
			logger.debug(`SessionWatcher: parse failed for ${filePath}:`, err);
		}
	}

	/**
	 * A session is surfaced only when a live agent process exists in its
	 * workspace. If the agent isn't running at all, it's definitely not live.
	 * If it's running but we couldn't read a workspacePath, fall back to
	 * "agent present" so we don't hide a genuinely active session.
	 */
	private async hasLiveProcess(
		update: ExternalSessionUpdate,
	): Promise<boolean> {
		const live = await this.scanner.getLiveAgents();
		if (!live.present.has(update.agentId)) return false;

		// A live process shares a cwd with all historical session logs in that
		// workspace, so cwd alone can't tell which session the process is using.
		// The discriminator is recency: only the session whose log was touched
		// within the freshness window belongs to the running process.
		const fresh = Date.now() - update.updatedAt <= LIVE_SESSION_FRESHNESS_MS;
		if (!fresh) return false;

		const cwds = live.cwds.get(update.agentId);
		if (!cwds || cwds.size === 0) {
			// Process exists but we have no per-process cwd on this platform
			// (e.g. Windows Win32_Process, or a restricted lsof/proc). Fall back to
			// recency alone — the 1h freshness window above still bounds it — so we
			// don't hide a genuinely active session.
			return true;
		}

		// A process's cwd is its LAUNCH directory. Match it against the session's
		// launch dir by EQUALITY — this is the precise owner relationship. Using
		// the session's drifting current cwd (workspacePath) here would either
		// miss the session (it cd'd into a subdir) or, with containment, falsely
		// claim sibling sessions launched in subdirs of the process cwd.
		if (update.launchCwd) {
			return cwds.has(update.launchCwd);
		}
		// No launch dir known: best-effort. The session's current cwd is a
		// descendant of (or equal to) its launch dir, so a process whose cwd is an
		// ancestor-or-equal is plausibly the owner.
		if (!update.workspacePath) return true;
		for (const procCwd of cwds) {
			if (pathContains(procCwd, update.workspacePath)) return true;
		}
		return false;
	}

	private report(update: ExternalSessionUpdate) {
		const key = `${update.agentId}:${update.sessionId}`;
		const previous = this.lastReported.get(key);
		// Avoid spamming identical finished states; only emit on change or while
		// running (so updatedAt stays fresh for recency filtering).
		if (
			previous &&
			previous.status === update.status &&
			update.status !== "running" &&
			previous.title === update.title &&
			previous.workspacePath === update.workspacePath
		) {
			return;
		}
		this.lastReported.set(key, update);
		this.onUpdate(update);
	}

	/**
	 * Periodic reconciliation: rescan processes, drop any surfaced session whose
	 * agent process has exited, and decay a stale "running" to "finished" once
	 * its log has been quiet (the process may still be alive but idle).
	 */
	private async reconcile() {
		const now = Date.now();
		// Force a fresh process scan so exits are detected promptly.
		await this.scanner.scan();
		for (const [key, update] of [...this.lastReported.entries()]) {
			const live = await this.hasLiveProcess(update);
			if (!live) {
				this.lastReported.delete(key);
				this.onRemove(update.agentId, update.sessionId);
				continue;
			}
			if (
				update.status === "running" &&
				now - update.updatedAt > ACTIVE_WINDOW_MS
			) {
				const finished: ExternalSessionUpdate = {
					...update,
					status: "finished",
					message: statusLabel("finished"),
					updatedAt: update.updatedAt,
				};
				this.lastReported.set(key, finished);
				this.onUpdate(finished);
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
		this.lastReported.clear();
	}
}

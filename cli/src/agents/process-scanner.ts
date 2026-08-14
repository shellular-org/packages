import { execFile } from "node:child_process";
import { readlinkSync } from "node:fs";

import type { AgentId } from "@shellular/protocol";

import { logger } from "@/logger";

/**
 * Liveness detection for the session watcher. Two uses: disambiguating "the CLI
 * finished its turn and is idle" from "the user killed the CLI mid-turn", and
 * proactively discovering live-but-idle sessions no file event will re-surface.
 *
 * Approach: scan the process table with `ps` for the agent's executable, then
 * read each candidate's cwd and start time. A session is attributable to a live
 * process only if that process runs in the session's launch directory AND
 * started before the session's last write — a log that stopped being written
 * before any live CLI existed cannot belong to one (this is what keeps stale
 * sessions from resurfacing after a reboot).
 *
 *   - macOS:   ps + `lsof -p <pids> -a -d cwd -Fn`
 *   - Linux:   ps + readlink /proc/<pid>/cwd
 *   - Windows: per-process cwd unreadable; liveness is unknown (see below).
 *
 * Neither CLI holds its session jsonl open (both append-and-close), so lsof
 * cannot map a PID to a session id. Directory + start time is the most precise
 * attribution available; the watcher additionally caps it to one session per
 * (agent, cwd) so N historical logs in a directory can't all claim one process.
 *
 * We deliberately avoid `pgrep`: on macOS it can't read the argv of hardened,
 * signed binaries (which the Claude and Codex CLIs are) and silently drops them
 * from its output, so the live process would never be found. `ps` lists them.
 */

function execFileAsync(
	file: string,
	args: string[],
	timeoutMs: number,
): Promise<string> {
	return new Promise((resolve) => {
		execFile(
			file,
			args,
			{ timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
			(_err, stdout) => resolve(stdout ?? ""),
		);
	});
}

/** True if a process command line is a real agent CLI (not an .app bundle). */
function isAgentCommand(agent: AgentId, command: string): boolean {
	const lower = command.toLowerCase().replace(/\\/g, "/");
	if (lower.includes(".app/contents/")) return false;
	// Match on the executable (argv[0]) only — the rest is arguments like
	// `--resume <id>`. Taking the basename of the whole command line would fold
	// the arguments in (e.g. "claude --resume x") and never equal "claude".
	const argv0 = lower.split(/\s+/, 1)[0] ?? "";
	const base = argv0.slice(argv0.lastIndexOf("/") + 1);
	if (agent === "claude-code") {
		return base === "claude" || lower.includes("/claude/versions/");
	}
	if (agent === "codex") {
		// Codex has shipped both `codex` and `codex-tui` executables. Keep the
		// match on argv[0] so arguments cannot create false positives, but accept
		// the executable prefix used by both distributions.
		return base === "codex" || base.startsWith("codex-");
	}
	return false;
}

/**
 * Returns candidate processes for the agent by scanning the process table.
 *
 * We use `ps`, NOT `pgrep`. On macOS, `pgrep -f` matches against a process's
 * argv read via KERN_PROCARGS2, which fails for hardened/signed binaries — and
 * the Claude and Codex CLIs are exactly that. Such processes are silently
 * omitted from pgrep's output entirely (verified: the live `claude` process is
 * absent from `pgrep -f .` while present in `ps`), which made every liveness
 * check come back negative and hid live-but-idle sessions. `ps` reads the
 * process table directly and lists them, so we scan its output ourselves.
 */
type CandidateProcess = {
	startedAt: number;
	command: string;
};

async function candidateProcesses(
	agent: AgentId,
): Promise<Map<number, CandidateProcess>> {
	const result = new Map<number, CandidateProcess>();
	try {
		// -A: all processes; -ww: don't truncate the command column. `lstart` is a
		// fixed-width absolute start time ("Fri Jul 31 15:29:20 2026"); it must come
		// before `command=` so the (space-containing) command stays last and the
		// columns before it can be split positionally.
		const output = await execFileAsync(
			"ps",
			["-Aww", "-o", "pid=,lstart=,command="],
			3000,
		);
		for (const line of output.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			// pid, then the 5 whitespace-separated lstart fields, then the command.
			const match = trimmed.match(
				/^(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/,
			);
			if (!match) continue;
			const pid = parseInt(match[1], 10);
			if (!Number.isFinite(pid)) continue;
			if (!isAgentCommand(agent, match[3])) continue;
			const started = Date.parse(match[2]);
			result.set(pid, {
				startedAt: Number.isFinite(started) ? started : 0,
				command: match[3],
			});
		}
	} catch {
		// ps unavailable/failed — no candidates; callers treat liveness as unknown.
	}
	return result;
}

/** Returns the cwd of a single PID, or undefined if unreadable. */
function pidCwdLinux(pid: number): string | undefined {
	try {
		return readlinkSync(`/proc/${pid}/cwd`);
	} catch {
		return undefined;
	}
}

/** Batch-reads cwds for PIDs via `lsof -p <pids> -a -d cwd -Fn`. */
async function pidCwdsMacos(pids: number[]): Promise<Map<number, string>> {
	const result = new Map<number, string>();
	if (pids.length === 0) return result;
	try {
		const output = await execFileAsync(
			"lsof",
			["-p", pids.join(","), "-a", "-d", "cwd", "-Fn"],
			3000,
		);
		let currentPid = 0;
		for (const line of output.split("\n")) {
			if (!line) continue;
			const tag = line[0];
			const value = line.slice(1);
			if (tag === "p") {
				currentPid = parseInt(value, 10) || 0;
			} else if (tag === "n" && currentPid) {
				result.set(currentPid, value);
			}
		}
	} catch (err) {
		logger.debug("process-scanner: lsof cwd lookup failed:", err);
	}
	return result;
}

/**
 * Live agent processes grouped by cwd, each with the earliest start time seen
 * for that directory. Used by the watcher to proactively discover sessions whose
 * CLI is still open but whose log has gone idle (so no file event re-triggers
 * the surfacing check), and to reject logs that went silent before any of those
 * processes existed.
 */
export type LiveAgentCwds = {
	/** cwd -> earliest start time (epoch ms) of a live agent process there. */
	cwds: Map<string, number>;
	/**
	 * True when per-process cwds could not be read at all (Windows, or lsof
	 * failing while candidates exist). Callers must not treat an empty `cwds` as
	 * "nothing is alive" in that case.
	 */
	unknown: boolean;
};

export type AgentProcessInfo = {
	pid: number;
	startedAt: number;
	cwd: string;
	command: string;
};

export async function liveAgentCwds(agent: AgentId): Promise<LiveAgentCwds> {
	const candidates = await candidateProcesses(agent);
	// No agent process at all is a definite answer, not an unknown one: this is
	// the post-reboot case, and it must clear every stale session.
	if (candidates.size === 0) return { cwds: new Map(), unknown: false };

	const cwds = new Map<string, number>();
	const record = (cwd: string, startedAt: number) => {
		const existing = cwds.get(cwd);
		if (existing === undefined || startedAt < existing)
			cwds.set(cwd, startedAt);
	};

	if (process.platform === "linux") {
		let readAny = false;
		for (const [pid, candidate] of candidates) {
			const cwd = pidCwdLinux(pid);
			if (cwd) {
				readAny = true;
				record(cwd, candidate.startedAt);
			}
		}
		return { cwds, unknown: !readAny };
	}

	if (process.platform === "darwin") {
		const pidCwds = await pidCwdsMacos([...candidates.keys()]);
		for (const [pid, cwd] of pidCwds) {
			record(cwd, candidates.get(pid)?.startedAt ?? 0);
		}
		// lsof returned nothing for live candidates — we can't attribute them.
		return { cwds, unknown: pidCwds.size === 0 };
	}

	// Windows / unknown: per-process cwd is unavailable.
	return { cwds, unknown: true };
}

/**
 * Find agent processes whose working directory matches a session workspace.
 * This is intentionally a fresh process-table lookup: callers use the result
 * for a destructive action and must not rely on an old liveness snapshot.
 */
export async function findAgentProcesses(
	agent: AgentId,
	cwd: string,
): Promise<AgentProcessInfo[]> {
	const candidates = await candidateProcesses(agent);
	if (candidates.size === 0) return [];

	const matches: AgentProcessInfo[] = [];
	const record = (pid: number, processCwd: string) => {
		if (processCwd !== cwd) return;
		const candidate = candidates.get(pid);
		if (!candidate) return;
		matches.push({
			pid,
			startedAt: candidate.startedAt,
			cwd: processCwd,
			command: candidate.command,
		});
	};

	if (process.platform === "linux") {
		for (const pid of candidates.keys()) {
			const processCwd = pidCwdLinux(pid);
			if (processCwd) record(pid, processCwd);
		}
	} else if (process.platform === "darwin") {
		const pidCwds = await pidCwdsMacos([...candidates.keys()]);
		for (const [pid, processCwd] of pidCwds) {
			record(pid, processCwd);
		}
	}

	return matches.sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Terminate a previously identified agent process after revalidating its PID,
 * executable and cwd. A PID supplied by a client is never trusted by itself.
 */
export async function terminateAgentProcess(
	agent: AgentId,
	owner: AgentProcessInfo,
): Promise<boolean> {
	const current = (await findAgentProcesses(agent, owner.cwd)).find(
		(processInfo) => processInfo.pid === owner.pid,
	);
	if (!current) return false;
	if (
		owner.startedAt > 0 &&
		current.startedAt > 0 &&
		owner.startedAt !== current.startedAt
	) {
		return false;
	}

	try {
		process.kill(current.pid, "SIGTERM");
	} catch (error) {
		return isProcessGoneError(error);
	}

	return waitForProcessExit(current.pid);
}

const PROCESS_EXIT_TIMEOUT_MS = 5000;
const PROCESS_EXIT_POLL_MS = 100;

function isProcessGoneError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !isProcessGoneError(error);
	}
}

async function waitForProcessExit(pid: number): Promise<boolean> {
	const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS;
	while (isProcessAlive(pid)) {
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, PROCESS_EXIT_POLL_MS));
	}
	return true;
}

/**
 * Whether a live agent process can account for a session in `cwd` whose log was
 * last written at `lastWriteMs`.
 *
 *   "alive"   — a process in that cwd started before the log's last write.
 *   "dead"    — no such process; the CLI is gone.
 *   "unknown" — liveness is unreadable on this platform; callers keep the
 *               session rather than removing it on a guess.
 *
 * The start-time comparison is what distinguishes a genuinely open CLI from a
 * historical log sitting in a directory where some *other* agent is running now.
 */
export async function isAgentAliveInCwd(
	agent: AgentId,
	cwd?: string,
	lastWriteMs?: number,
): Promise<"alive" | "dead" | "unknown"> {
	if (!cwd) return "unknown";
	const { cwds, unknown } = await liveAgentCwds(agent);
	if (unknown) return "unknown";
	const startedAt = cwds.get(cwd);
	if (startedAt === undefined) return "dead";
	return isAttributable(startedAt, lastWriteMs) ? "alive" : "dead";
}

/**
 * True if a process started at `startedAt` could have produced a log last
 * written at `lastWriteMs`. A log that stopped being written before the process
 * launched belongs to an earlier, now-dead CLI in the same directory.
 *
 * `startedAt` of 0 means the start time was unparseable — don't reject on it.
 */
export function isAttributable(
	startedAt: number,
	lastWriteMs?: number,
): boolean {
	if (!startedAt || lastWriteMs === undefined) return true;
	// `ps` reports whole seconds, so a process can appear to start up to a second
	// after the write it actually produced.
	return lastWriteMs >= startedAt - 1000;
}

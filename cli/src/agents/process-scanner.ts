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
 * read each candidate's cwd and compare it to the session's launch directory.
 * If no candidate matches, the CLI is gone.
 *
 *   - macOS:   ps + `lsof -p <pids> -a -d cwd -Fn`
 *   - Linux:   ps + readlink /proc/<pid>/cwd
 *   - Windows: per-process cwd unreadable; fall back to "assume alive" (session
 *              decays to a sticky finished rather than being removed).
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
		return base === "codex" || /\/codex(\/|$|-)/.test(argv0);
	}
	return false;
}

/**
 * Returns candidate PIDs for the agent by scanning the process table.
 *
 * We use `ps`, NOT `pgrep`. On macOS, `pgrep -f` matches against a process's
 * argv read via KERN_PROCARGS2, which fails for hardened/signed binaries — and
 * the Claude and Codex CLIs are exactly that. Such processes are silently
 * omitted from pgrep's output entirely (verified: the live `claude` process is
 * absent from `pgrep -f .` while present in `ps`), which made every liveness
 * check come back negative and hid live-but-idle sessions. `ps` reads the
 * process table directly and lists them, so we scan its output ourselves.
 */
async function candidatePids(agent: AgentId): Promise<Map<number, string>> {
	const result = new Map<number, string>();
	try {
		// -A: all processes; -ww: don't truncate the command column.
		const output = await execFileAsync(
			"ps",
			["-Aww", "-o", "pid=,command="],
			3000,
		);
		for (const line of output.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			const spaceIdx = trimmed.indexOf(" ");
			if (spaceIdx === -1) continue;
			const pid = parseInt(trimmed.slice(0, spaceIdx), 10);
			if (!Number.isFinite(pid)) continue;
			const command = trimmed.slice(spaceIdx + 1);
			if (isAgentCommand(agent, command)) result.set(pid, command);
		}
	} catch {
		// ps unavailable/failed — callers fall back to "assume alive".
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
 * Returns the set of cwds of live agent processes for the given agent. Used by
 * the watcher to proactively discover sessions whose CLI is still open but whose
 * log has gone idle (so no file event re-triggers the surfacing check). Empty
 * when no process is found, or when per-process cwds can't be read on this
 * platform (Windows) — in which case proactive discovery is simply skipped.
 */
export async function liveAgentCwds(agent: AgentId): Promise<Set<string>> {
	const candidates = await candidatePids(agent);
	if (candidates.size === 0) return new Set();

	if (process.platform === "linux") {
		const cwds = new Set<string>();
		for (const pid of candidates.keys()) {
			const cwd = pidCwdLinux(pid);
			if (cwd) cwds.add(cwd);
		}
		return cwds;
	}

	if (process.platform === "darwin") {
		const cwds = await pidCwdsMacos([...candidates.keys()]);
		return new Set(cwds.values());
	}

	// Windows / unknown: per-process cwd is unavailable.
	return new Set();
}

/**
 * Returns true if a live agent process exists in the given cwd (the session's
 * launch directory). If cwd is undefined or we can't read per-process cwds on
 * this platform, returns true (assume alive — the session decays to a sticky
 * finished rather than being wrongly removed).
 */
export async function isAgentAliveInCwd(
	agent: AgentId,
	cwd?: string,
): Promise<boolean> {
	if (!cwd) return true;
	const candidates = await candidatePids(agent);
	if (candidates.size === 0) return false;

	if (process.platform === "linux") {
		for (const pid of candidates.keys()) {
			if (pidCwdLinux(pid) === cwd) return true;
		}
		// Process exists but cwd wasn't readable — assume alive.
		return true;
	}

	if (process.platform === "darwin") {
		const cwds = await pidCwdsMacos([...candidates.keys()]);
		if (cwds.size === 0) return true; // lsof failed — assume alive
		for (const procCwd of cwds.values()) {
			if (procCwd === cwd) return true;
		}
		// Agent process exists but in a different cwd.
		return false;
	}

	// Windows / unknown: can't read per-process cwd — assume alive.
	return true;
}

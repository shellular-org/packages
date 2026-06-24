import { execFile } from "node:child_process";
import { readlinkSync } from "node:fs";

import type { AiBackend } from "@shellular/protocol";

import { logger } from "@/logger";

/**
 * Minimal liveness disambiguation for the session watcher. Used ONLY to
 * distinguish "the agent CLI finished its turn and is idle" from "the user
 * killed / closed the CLI mid-turn" — not as a general surfacing gate (recency
 * handles that). Called infrequently: only when a running/permission session
 * has been silent long enough that we need to check whether the process is
 * still alive.
 *
 * Approach: `pgrep -f` finds candidate PIDs cheaply (kernel process table,
 * not every open file). Then we read each candidate's cwd and compare it to
 * the session's launch directory. If no candidate matches, the CLI is gone.
 *
 *   - macOS:   pgrep + `lsof -p <pids> -a -d cwd -Fn`
 *   - Linux:   pgrep + readlink /proc/<pid>/cwd
 *   - Windows: pgrep unavailable; fall back to "assume alive" (session decays
 *              to a sticky finished rather than being removed).
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
function isAgentCommand(agent: AiBackend, command: string): boolean {
	const lower = command.toLowerCase().replace(/\\/g, "/");
	if (lower.includes(".app/contents/")) return false;
	const base = lower.slice(lower.lastIndexOf("/") + 1);
	if (agent === "claude-code") {
		return base === "claude" || lower.includes("/claude/versions/");
	}
	if (agent === "codex") {
		return base === "codex" || /\/codex(\/|$|-)/.test(lower);
	}
	return false;
}

/** Returns candidate PIDs for the agent via `pgrep -fl`. */
async function candidatePids(agent: AiBackend): Promise<Map<number, string>> {
	const pattern = agent === "claude-code" ? "claude" : "codex";
	const result = new Map<number, string>();
	try {
		const output = await execFileAsync("pgrep", ["-fl", pattern], 3000);
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
		// pgrep not available or failed — callers fall back to "assume alive".
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
 * Returns true if a live agent process exists in the given cwd (the session's
 * launch directory). If cwd is undefined or we can't read per-process cwds on
 * this platform, returns true (assume alive — the session decays to a sticky
 * finished rather than being wrongly removed).
 */
export async function isAgentAliveInCwd(
	agent: AiBackend,
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

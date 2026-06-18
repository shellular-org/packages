import { execFile } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import type { AiBackend } from "@shellular/protocol";

import { logger } from "@/logger";

/**
 * Detects which agent CLIs (claude / codex) are actually running, and in which
 * working directories. This is the gate for surfacing externally-observed
 * sessions: a session is only shown if a live process exists for its agent in
 * its workspace. Without this, the watcher would surface every historical
 * session log on disk.
 *
 * Cross-platform: agents don't hold their session .jsonl open (append+close),
 * so file-handle matching is unreliable — we match on each process's cwd and
 * executable path. How we read those differs per OS:
 *   - macOS:   `lsof` (single pass for command + cwd + txt/exe path)
 *   - Linux:   /proc/<pid>/{cwd,exe,cmdline} (no external binary)
 *   - Windows: PowerShell Win32_Process (Name + ExecutablePath + CommandLine;
 *              per-process cwd isn't readily available, so matching falls back
 *              to "agent present" + the session log's recency, handled upstream).
 */

export type LiveAgentProcesses = {
	/** Per-agent set of absolute cwds that currently have a live process. */
	cwds: Map<AiBackend, Set<string>>;
	/** True if at least one process was found for the agent (any cwd). */
	present: Set<AiBackend>;
};

type ProcInfo = {
	pid: string;
	/** Process command/argv0 name, if known. */
	command?: string;
	/** Current working directory, if obtainable on this platform. */
	cwd?: string;
	/** Candidate executable/command paths used to identify the agent. */
	paths: string[];
};

function execFileAsync(
	file: string,
	args: string[],
	timeoutMs: number,
): Promise<string> {
	return new Promise((resolve) => {
		execFile(
			file,
			args,
			{ timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
			(err, stdout) => {
				// Some tools exit non-zero when a few entries are inaccessible; stdout
				// is still usable, so parse whatever we got.
				if (err && !stdout) {
					logger.debug(`process-scanner: ${file} failed:`, err.message);
				}
				resolve(stdout ?? "");
			},
		);
	});
}

/**
 * Identifies whether a process is one of our agents from its command name and
 * candidate paths. Works across platforms: the claude native binary is often
 * exec'd with argv0 set to its version, so the executable PATH is the reliable
 * signal (`.../claude/versions/<v>`, or a `claude`/`codex` binary name).
 */
function classifyAgent(proc: ProcInfo): AiBackend | undefined {
	const command = (proc.command ?? "").toLowerCase();
	const base = basename(command);
	if (base === "claude" || base === "claude.exe") return "claude-code";
	if (base === "codex" || base === "codex.exe") return "codex";

	for (const raw of proc.paths) {
		const lower = raw.toLowerCase().replace(/\\/g, "/");
		if (
			lower.includes("/claude/versions/") ||
			/\/claude(\.exe)?(\/|$)/.test(lower)
		) {
			return "claude-code";
		}
		if (/\/codex(\.exe)?(\/|$|-)/.test(lower)) return "codex";
	}
	return undefined;
}

function basename(p: string): string {
	const norm = p.replace(/\\/g, "/");
	const idx = norm.lastIndexOf("/");
	return idx === -1 ? norm : norm.slice(idx + 1);
}

// ─── macOS: lsof ────────────────────────────────────────────────────────────

/**
 * Parses `lsof -nP -Fpcfn -d cwd,txt`. The -F format emits one field per line,
 * prefixed by a type char: p=pid, c=command, f=fd, n=name.
 */
function parseLsof(output: string): ProcInfo[] {
	const procs: ProcInfo[] = [];
	let current: ProcInfo | undefined;
	let fd = "";
	for (const line of output.split("\n")) {
		if (!line) continue;
		const tag = line[0];
		const value = line.slice(1);
		switch (tag) {
			case "p":
				if (current) procs.push(current);
				current = { pid: value, paths: [] };
				fd = "";
				break;
			case "c":
				if (current) current.command = value;
				break;
			case "f":
				fd = value;
				break;
			case "n":
				if (!current) break;
				if (fd === "cwd") current.cwd = value;
				else if (fd === "txt") current.paths.push(value);
				break;
			default:
				break;
		}
	}
	if (current) procs.push(current);
	return procs;
}

async function collectMacos(): Promise<ProcInfo[]> {
	const output = await execFileAsync(
		"lsof",
		["-nP", "-Fpcfn", "-d", "cwd,txt"],
		4000,
	);
	return parseLsof(output);
}

// ─── Linux: /proc ─────────────────────────────────────────────────────────────

function collectLinux(): ProcInfo[] {
	const procs: ProcInfo[] = [];
	let pids: string[];
	try {
		pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
	} catch {
		return procs;
	}
	for (const pid of pids) {
		try {
			// cmdline is NUL-separated argv; argv0 is the command/exe.
			let argv0: string | undefined;
			try {
				const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
				argv0 = cmdline.split("\0")[0] || undefined;
			} catch {
				// process may have exited or be inaccessible
			}
			let exe: string | undefined;
			try {
				exe = readlinkSync(`/proc/${pid}/exe`);
			} catch {
				// /proc/<pid>/exe requires matching uid/caps; ok if missing
			}
			const paths = [argv0, exe].filter((p): p is string => Boolean(p));
			if (paths.length === 0) continue;
			// Quick prefilter so we only readlink cwd for likely agents.
			const proc: ProcInfo = { pid, command: argv0, paths };
			if (!classifyAgent(proc)) continue;
			try {
				proc.cwd = readlinkSync(`/proc/${pid}/cwd`);
			} catch {
				// cwd not readable; upstream falls back to recency
			}
			procs.push(proc);
		} catch {
			// ignore unreadable pid
		}
	}
	return procs;
}

// ─── Windows: PowerShell Win32_Process ─────────────────────────────────────────

async function collectWindows(): Promise<ProcInfo[]> {
	// Get name + executable path + command line as JSON. Per-process cwd is not
	// exposed by Win32_Process, so cwd stays undefined and matching falls back to
	// agent-present + session recency (handled by the watcher).
	const script =
		"Get-CimInstance Win32_Process | " +
		"Select-Object ProcessId,Name,ExecutablePath,CommandLine | " +
		"ConvertTo-Json -Compress";
	const output = await execFileAsync(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-Command", script],
		6000,
	);
	if (!output.trim()) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		return [];
	}
	const rows = Array.isArray(parsed) ? parsed : [parsed];
	const procs: ProcInfo[] = [];
	for (const row of rows) {
		if (!row || typeof row !== "object") continue;
		const r = row as Record<string, unknown>;
		const name = typeof r.Name === "string" ? r.Name : undefined;
		const exe =
			typeof r.ExecutablePath === "string" ? r.ExecutablePath : undefined;
		const cmd = typeof r.CommandLine === "string" ? r.CommandLine : undefined;
		const paths = [name, exe, cmd].filter((p): p is string => Boolean(p));
		if (paths.length === 0) continue;
		procs.push({
			pid: String(r.ProcessId ?? ""),
			command: name,
			paths,
		});
	}
	return procs;
}

export class ProcessScanner {
	private cached: LiveAgentProcesses = {
		cwds: new Map(),
		present: new Set(),
	};
	private lastScan = 0;

	/** Returns cached liveness if scanned within `maxAgeMs`, else rescans. */
	async getLiveAgents(maxAgeMs = 5000): Promise<LiveAgentProcesses> {
		if (Date.now() - this.lastScan < maxAgeMs) return this.cached;
		return this.scan();
	}

	async scan(): Promise<LiveAgentProcesses> {
		const cwds = new Map<AiBackend, Set<string>>();
		const present = new Set<AiBackend>();
		try {
			const procs = await this.collect();
			for (const proc of procs) {
				const agent = classifyAgent(proc);
				if (!agent) continue;
				present.add(agent);
				if (proc.cwd) {
					let set = cwds.get(agent);
					if (!set) {
						set = new Set();
						cwds.set(agent, set);
					}
					set.add(proc.cwd);
				}
			}
		} catch (err) {
			logger.debug("process-scanner: scan error:", err);
		}
		this.cached = { cwds, present };
		this.lastScan = Date.now();
		return this.cached;
	}

	private collect(): Promise<ProcInfo[]> | ProcInfo[] {
		switch (process.platform) {
			case "darwin":
				return collectMacos();
			case "linux":
				return collectLinux();
			case "win32":
				return collectWindows();
			default:
				// Unknown platform: try lsof, harmless if absent.
				return collectMacos();
		}
	}
}

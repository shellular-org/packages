import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

import chalk from "chalk";
import pm2 from "pm2";

import {
	clearStaleLock,
	getBootLockData,
	isBootLockActive,
	type LockData,
} from "@/boot-lock";
import { config } from "@/config";
import { logger } from "@/logger";
import { preStart } from "@/pre-start";
import { getFileSize, streamFile } from "@/utils";

export type DaemonOptions = {
	server: string;
	dir: string;
	unknownClients: "always-reject" | "always-allow" | "requires-approval";
	qr: boolean;
};

export type DaemonStartOptions = DaemonOptions & {
	logStream?: boolean;
};

type Pm2Process = pm2.ProcessDescription;

type LogOffsets = {
	out: number;
	err: number;
};

const DAEMON_MAX_RESTARTS = 5;
const DAEMON_MIN_UPTIME_MS = 10_000;

function getLogPaths(): { out: string; err: string } {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	return {
		out: path.join(config.LOGS_DIR, `${config.NAME}.${timestamp}.log`),
		err: path.join(config.LOGS_DIR, `${config.NAME}.${timestamp}.error.log`),
	};
}

function getLatestLogPaths(): { out: string; err: string } | null {
	try {
		const files = fs
			.readdirSync(config.LOGS_DIR)
			// Daemon stdout logs are named `shellular.<timestamp>.log`
			.filter(
				(f) =>
					f.startsWith(`${config.NAME}.`) &&
					f.endsWith(".log") &&
					!f.endsWith(".error.log"),
			)
			.sort()
			.reverse();

		const latest = files[0];
		if (!latest) {
			return null;
		}

		return {
			out: path.join(config.LOGS_DIR, latest),
			err: path.join(config.LOGS_DIR, latest.replace(/\.log$/, ".error.log")),
		};
	} catch {
		return null;
	}
}

function getPm2Env(): Record<string, string> {
	return Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);
}

function resolveLocalTsx(): string | null {
	const localTsx = path.join(process.cwd(), "node_modules", ".bin", "tsx");
	if (fs.existsSync(localTsx)) return localTsx;

	try {
		const globalTsx = path.join(path.dirname(process.execPath), "tsx");
		if (fs.existsSync(globalTsx)) return globalTsx;
	} catch {}

	return null;
}

function getDaemonScriptOptions(): {
	script: string;
	interpreter: string;
	interpreterArgs?: string[];
} {
	const localTsx = resolveLocalTsx();

	const tsBinaries = ["tsx", "ts-node", "esr"];
	function isTsxBinary(p: string): boolean {
		const base = path.basename(p).replace(/\.(exe|cmd|bat)$/, "");
		return tsBinaries.includes(base);
	}

	let tsScriptPath: string | null = null;
	let tsxBinPath: string | null = null;

	for (let i = 1; i < process.argv.length; i++) {
		const arg = process.argv[i];
		if (arg.startsWith("--")) continue;
		const resolved = path.resolve(arg);

		if (resolved.endsWith(".ts") && fs.existsSync(resolved)) {
			tsScriptPath = resolved;
			break;
		}

		if (isTsxBinary(resolved) || isTsxBinary(arg)) {
			tsxBinPath = resolved;
		}
	}

	if (tsScriptPath) {
		const interpreter = tsxBinPath ?? localTsx ?? "tsx";
		return { script: tsScriptPath, interpreter };
	}

	if (tsxBinPath) {
		return { script: tsxBinPath, interpreter: process.execPath };
	}

	const scriptPath = path.resolve(process.argv[1] ?? "");
	return { script: scriptPath, interpreter: process.execPath };
}

function connectPm2(): Promise<void> {
	return new Promise((resolve, reject) => {
		pm2.connect((err) => {
			if (err) reject(err);
			else resolve();
		});
	});
}

async function withPm2<T>(fn: () => Promise<T>): Promise<T> {
	await connectPm2();
	try {
		return await fn();
	} finally {
		pm2.disconnect();
	}
}

function describeDaemon(): Promise<Pm2Process | null> {
	return new Promise((resolve, reject) => {
		pm2.describe(config.NAME, (err, processes) => {
			if (err) {
				reject(err);
				return;
			}
			resolve(processes[0] ?? null);
		});
	});
}

function startDaemonProcess(
	options: DaemonOptions,
	logs: { out: string; err: string },
): Promise<void> {
	const script = getDaemonScriptOptions();

	return new Promise((resolve, reject) => {
		const args = [
			"__daemon",
			"--server",
			options.server,
			"--dir",
			path.resolve(options.dir),
			"--unknown-clients",
			options.unknownClients,
		];
		if (!options.qr) {
			args.push("--no-qr");
		}

		pm2.start(
			{
				name: config.NAME,
				script: script.script,
				args,
				cwd: process.cwd(),
				output: logs.out,
				error: logs.err,
				interpreter: script.interpreter,
				exec_mode: "fork",
				instances: 1,
				autorestart: true,
				max_restarts: DAEMON_MAX_RESTARTS,
				min_uptime: DAEMON_MIN_UPTIME_MS,
				force: false,
				merge_logs: true,
				time: false,
				kill_timeout: 5000,
				env: getPm2Env(),
			},
			(err) => {
				if (err) reject(err);
				else resolve();
			},
		);
	});
}

function deleteDaemon(): Promise<void> {
	return new Promise((resolve, reject) => {
		pm2.delete(config.NAME, (err) => {
			if (err) reject(err);
			else resolve();
		});
	});
}

function stopPm2Daemon(): Promise<void> {
	return new Promise((resolve, reject) => {
		pm2.stop(config.NAME, (err) => {
			if (err) reject(err);
			else resolve();
		});
	});
}

function dumpPm2ProcessList(): Promise<void> {
	return new Promise((resolve, reject) => {
		pm2.dump((err) => {
			if (err) reject(err);
			else resolve();
		});
	});
}

/**
 * pm2's programmatic `startup`/`uninstallStartup` API (lib/API/Startup.js)
 * isn't actually safe to call from another process: `isNotRoot()` reads
 * `require.main.filename` (undefined outside a CJS entrypoint — we're ESM —
 * which throws) and, when a user is supplied, indexes into `opts.args[1]`
 * expecting a commander `Command` from pm2's own CLI parser. Both of pm2's
 * own typed/untyped call shapes assume they're driven by pm2's `bin/pm2`,
 * not called as a library. So instead we shell out to that same `pm2` binary,
 * exactly as the documented `pm2 startup` / `pm2 unstartup` workflow does —
 * this also means the user sees pm2's own colored output and the `sudo ...`
 * command it prints, live, instead of us trying to recreate it.
 */
const pm2BinPath = createRequire(import.meta.url).resolve("pm2/bin/pm2");

/**
 * `pm2 startup` / `pm2 unstartup` exit with code 1 when run without root —
 * that's not a failure, it's pm2 printing the exact `sudo ...` command to
 * copy/paste and re-run. Any other non-zero exit is a real failure.
 */
function runPm2StartupCli(arg: "startup" | "unstartup"): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [pm2BinPath, arg], {
			stdio: "inherit",
			env: {
				/**
				 * `pm2`'s own package entrypoint (lib/index.js) sets
				 * `process.env.PM2_PROGRAMMATIC = 'true'` as a side effect of merely being
				 * imported — which we do, above, for the rest of this file's `pm2.*` calls.
				 * That flag leaks into any child process by default (spawn inherits env),
				 * and pm2's `Common.printOut` silently no-ops whenever it's set. Without
				 * stripping it back out here, the spawned `pm2 startup`/`unstartup` CLI
				 * loses its own status lines (e.g. "Init System found: launchd") even
				 * though it still prints the actual `sudo ...` command via plain
				 * `console.log`. Force both silencing flags off for this child only.
				 */
				...process.env,
				PM2_PROGRAMMATIC: undefined,
				PM2_SILENT: undefined,
			},
		});

		child.on("close", (code) => {
			if (code === 0 || code === 1) {
				// apparently pm2's startup/unstartup commands return 1 when they print the "you need to run this with sudo" message,
				// so treat that as success (the user can re-run the printed command themselves).
				resolve();
			} else {
				reject(new Error(`pm2 ${arg} exited with code ${code}`));
			}
		});

		child.on("error", reject);
	});
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (days > 0) return `${days}d ${hours % 24}h`;
	if (hours > 0) return `${hours}h ${minutes % 60}m`;
	if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
	return `${seconds}s`;
}

function writeLockDetails(lock: LockData): void {
	logger.debug(`Lock PID: ${chalk.yellow(lock.pid.toString())}`);
	if (lock.connectionId) {
		logger.debug(`Connection: ${chalk.cyan(lock.connectionId)}`);
	}
	if (lock.serverUrl) {
		logger.debug(`Server: ${chalk.white(lock.serverUrl)}`);
	}
	if (lock.workDir) {
		logger.debug(`Directory: ${chalk.white(lock.workDir)}`);
	}
}

async function streamDaemonLogs(
	logs: { out: string; err: string },
	offsets?: LogOffsets,
) {
	const startOffsets = offsets ?? {
		out: Math.max(0, getFileSize(logs.out) - 16_000),
		err: Math.max(0, getFileSize(logs.err) - 16_000),
	};

	logger.log(chalk.dim(`Streaming ${config.NAME} logs. Press Ctrl+C to exit.`));

	const outHandle = streamFile(logs.out, startOffsets.out, process.stdout);
	const errHandle = streamFile(logs.err, startOffsets.err, process.stderr);

	const noDataTimer = setTimeout(() => {
		if (!outHandle.hasData && !errHandle.hasData) {
			logger.warn("No output received from daemon yet.");
			logger.warn("Check that the daemon started successfully.");
		}
	}, 10_000);

	await new Promise<void>((resolve) => {
		const stop = () => {
			clearTimeout(noDataTimer);
			outHandle.stop();
			errHandle.stop();
			resolve();
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
	});
}

function pollDaemonReady(timeoutMs = 10_000): Promise<Pm2Process | null> {
	return new Promise((resolve) => {
		const deadline = Date.now() + timeoutMs;

		const check = () => {
			describeDaemon()
				.then((proc) => {
					if (!proc) {
						if (Date.now() > deadline) {
							resolve(null);
							return;
						}
						setTimeout(check, 500);
						return;
					}

					const status = proc.pm2_env?.status;
					if (status === "online") {
						resolve(proc);
					} else if (
						status === "errored" ||
						status === "stopped" ||
						status === "stopping"
					) {
						resolve(proc);
					} else if (Date.now() > deadline) {
						resolve(proc);
					} else {
						setTimeout(check, 500);
					}
				})
				.catch(() => {
					if (Date.now() > deadline) {
						resolve(null);
					} else {
						setTimeout(check, 500);
					}
				});
		};

		check();
	});
}

export async function startDaemon(
	options: DaemonOptions,
	streamLogs: boolean,
): Promise<void> {
	logger.log("Starting Shellular daemon...");

	const activeLockData = getBootLockData();
	clearStaleLock();
	if (activeLockData && isBootLockActive(activeLockData)) {
		logger.log(chalk.yellow("Shellular CLI is already running."));
		writeLockDetails(activeLockData);
		const daemon = await withPm2(describeDaemon);
		if (streamLogs && daemon?.pm2_env?.status === "online") {
			const latestLogs = getLatestLogPaths();
			if (latestLogs) {
				await streamDaemonLogs(latestLogs);
			}
		}
		return;
	}

	await preStart(options);

	const logs = getLogPaths();
	const offsets = {
		out: getFileSize(logs.out),
		err: getFileSize(logs.err),
	};

	await withPm2(async () => {
		const existing = await describeDaemon();
		if (existing?.pm2_env?.status === "online") {
			logger.log(chalk.yellow(`${config.NAME} is already online.`));
			return;
		}
		if (existing) {
			await deleteDaemon();
		}
		await startDaemonProcess(options, logs);
	});

	logger.log("Waiting for daemon to start...");
	const daemon = await withPm2(async () => pollDaemonReady());

	if (!daemon) {
		logger.error(chalk.red("Failed to detect daemon status."));
		logger.error("Run 'shellular status' to check.");
		process.exit(1);
	}

	const status = daemon.pm2_env?.status;
	if (status === "errored" || status === "stopped") {
		const errSize = getFileSize(logs.err);
		if (errSize > 0) {
			logger.error(chalk.red("Daemon failed to start. Error output:"));
			const content = fs.readFileSync(logs.err, "utf8");
			const tail = content.slice(-4096);
			for (const line of tail.split("\n")) {
				if (line.trim()) logger.error(line);
			}
		} else {
			logger.error(chalk.red("Daemon failed to start. No error output found."));
		}

		await withPm2(async () => {
			const still = await describeDaemon();
			if (still) await deleteDaemon();
		});
		process.exit(1);
	}

	if (status === "online") {
		logger.log(chalk.green("Daemon is running."));
	} else if (streamLogs) {
		logger.warn(
			`Daemon status: ${chalk.yellow(status ?? "unknown")}. Streaming logs...`,
		);
	}

	// Non-interactive callers must return so the process
	// can exit; only the interactive `start` tails logs and waits for Ctrl+C.
	if (!streamLogs) {
		return;
	}

	await streamDaemonLogs(logs, offsets);
}

/**
 * Recover the original `__daemon` launch options from a running PM2 spec. PM2
 * records the args it launched the daemon with, so this is an in-sync source of
 * what server/dir/policy the daemon is actually running with — no need to also
 * stash them in the boot lock.
 */
function readDaemonOptions(daemon: Pm2Process): Partial<DaemonOptions> {
	// `args` is present at runtime but missing from PM2's `Pm2Env` typings.
	const args = (daemon.pm2_env as { args?: unknown } | undefined)?.args;
	if (!Array.isArray(args)) return {};

	const valueAfter = (flag: string): string | undefined => {
		const i = args.indexOf(flag);
		const value = i >= 0 ? args[i + 1] : undefined;
		return typeof value === "string" ? value : undefined;
	};

	return {
		server: valueAfter("--server"),
		dir: valueAfter("--dir"),
		unknownClients: valueAfter("--unknown-clients") as
			| DaemonOptions["unknownClients"]
			| undefined,
		qr: !args.includes("--no-qr"),
	};
}

export async function restartDaemon(): Promise<void> {
	const restarted = await withPm2(async () => {
		const daemon = await describeDaemon();
		if (!daemon) {
			return false;
		}
		await new Promise<void>((resolve, reject) => {
			pm2.restart(config.NAME, (err) => {
				if (err) reject(err);
				else resolve();
			});
		});
		return true;
	});

	if (!restarted) {
		logger.log("Shellular daemon is not running. Use 'start' to launch it.");
		return;
	}

	logger.log(chalk.green("Shellular daemon restarted."));
}

export async function stopDaemon(shouldDelete: boolean): Promise<void> {
	const stopped = await withPm2(async () => {
		const daemon = await describeDaemon();
		if (!daemon) {
			return false;
		}

		if (shouldDelete) {
			await deleteDaemon();
		} else {
			await stopPm2Daemon();
		}
		return true;
	});

	if (stopped) {
		clearStaleLock();
		logger.log(chalk.green("Shellular daemon stopped."));
		return;
	}

	const activeLockData = getBootLockData();
	if (activeLockData && isBootLockActive(activeLockData)) {
		logger.log(chalk.yellow("Shellular is running, but not under PM2."));
		writeLockDetails(activeLockData);
		return;
	}

	logger.log("Shellular daemon is not running.");
}

export async function showDaemonLogs(): Promise<void> {
	const logs = getLatestLogPaths();
	if (!logs) {
		logger.log("No log files found.");
		return;
	}
	await streamDaemonLogs(logs);
}

export async function showDaemonStatus(): Promise<void> {
	const daemon = await withPm2(describeDaemon);
	const activeLockData = getBootLockData();

	if (!daemon) {
		logger.log(chalk.red("Daemon is not running."));
		return;
	}

	const status = daemon.pm2_env?.status ?? "unknown";

	if (status === "online") {
		const uptime = daemon.pm2_env?.pm_uptime
			? formatDuration(Date.now() - daemon.pm2_env.pm_uptime)
			: "n/a";

		logger.log(chalk.green("Daemon is running."));
		logger.log(`Uptime: ${uptime}`);
	} else {
		logger.log(chalk.yellow(`Daemon status: ${status}`));
	}

	const pid = daemon.pid ? daemon.pid.toString() : "n/a";
	const restarts = daemon.pm2_env?.restart_time ?? 0;
	const memory = daemon.monit?.memory
		? `${Math.round(daemon.monit.memory / 1024 / 1024)} MB`
		: "n/a";

	logger.log(`Version: ${config.VERSION}`);
	logger.log(`PID: ${pid}`);
	logger.log(`Restarts: ${restarts}`);
	logger.log(`Memory: ${memory}`);

	// The args the daemon is actually running with (read back from PM2). Handy for
	// confirming a self-update relaunched onto the same server/dir/policy.
	const opts = readDaemonOptions(daemon);
	if (opts.server) {
		logger.log(`Server: ${chalk.white(opts.server)}`);
	}
	if (opts.dir) {
		logger.log(`Directory: ${chalk.white(opts.dir)}`);
	}
	if (opts.unknownClients) {
		logger.log(`Unknown clients: ${chalk.white(opts.unknownClients)}`);
	}

	const latestLogs = getLatestLogPaths();
	if (latestLogs) {
		logger.log(`Logs: ${chalk.dim(latestLogs.out)}`);
		logger.log(`Errors: ${chalk.dim(latestLogs.err)}`);
	} else {
		logger.error("Logs: n/a");
	}

	logger.log();
	if (activeLockData && isBootLockActive(activeLockData)) {
		logger.debug("Connection lock: active");
		writeLockDetails(activeLockData);
	} else {
		logger.debug("Connection lock: inactive");
		if (activeLockData) {
			logger.debug(chalk.dim(`Stale lock PID: ${activeLockData.pid}`));
		}
	}
}

/**
 * Equivalent of `pm2 startup && pm2 save`: installs an OS boot service
 * (launchd on macOS, systemd on Linux) that resurrects the daemon's process
 * list on machine startup, then saves the current process list so there's
 * something to resurrect. Most platforms require the first step to run as
 * root/sudo — `pm2 startup` detects that itself and prints (to inherited
 * stdio, so the user sees it directly) the exact command to re-run.
 */
export async function enableStartup(): Promise<void> {
	const daemon = await withPm2(describeDaemon);
	if (daemon?.pm2_env?.status !== "online") {
		logger.error(
			chalk.red(
				"Shellular daemon is not running. Run 'shellular start' first.",
			),
		);
		process.exitCode = 1;
		return;
	}

	try {
		await runPm2StartupCli("startup");
	} catch (err) {
		logger.error(
			chalk.red(
				`Failed to install boot service: ${err instanceof Error ? err.message : String(err)}`,
			),
		);
		process.exitCode = 1;
		return;
	}

	try {
		await withPm2(dumpPm2ProcessList);
	} catch (err) {
		logger.error(
			chalk.red(
				`Boot service installed, but failed to save the process list: ${err instanceof Error ? err.message : String(err)}`,
			),
		);
		logger.error("Run 'shellular startup' again once the daemon is running.");
		process.exitCode = 1;
		return;
	}
}

export async function disableStartup(): Promise<void> {
	try {
		await runPm2StartupCli("unstartup");
	} catch (err) {
		logger.error(
			chalk.red(
				`Failed to remove boot service: ${err instanceof Error ? err.message : String(err)}`,
			),
		);
		process.exitCode = 1;
		return;
	}
}

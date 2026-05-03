import fs from "node:fs";
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

type DaemonOptions = {
	server: string;
	dir: string;
	unknownClients: "always-reject" | "always-allow" | "requires-approval";
};

type Pm2Process = pm2.ProcessDescription;

type LogOffsets = {
	out: number;
	err: number;
};

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

function getFileSize(filePath: string): number {
	try {
		return fs.statSync(filePath).size;
	} catch {
		return 0;
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
		pm2.start(
			{
				name: config.NAME,
				script: script.script,
				args: [
					"__daemon",
					"--server",
					options.server,
					"--dir",
					path.resolve(options.dir),
					"--unknown-clients",
					options.unknownClients,
				],
				cwd: process.cwd(),
				output: logs.out,
				error: logs.err,
				interpreter: script.interpreter,
				exec_mode: "fork",
				instances: 1,
				autorestart: true,
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

function streamFile(
	filePath: string,
	startAt: number,
	stream: NodeJS.WriteStream,
) {
	let offset = startAt;
	let hasData = offset > 0;

	const readNewData = () => {
		const size = getFileSize(filePath);
		if (size < offset) {
			offset = 0;
		}
		if (size <= offset) {
			return;
		}

		const reader = fs.createReadStream(filePath, {
			start: offset,
			end: size - 1,
		});
		offset = size;
		hasData = true;
		reader.pipe(stream, { end: false });
	};

	readNewData();
	const timer = setInterval(readNewData, 500);
	return {
		stop: () => {
			clearInterval(timer);
		},
		get hasData() {
			return hasData;
		},
	};
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

export async function startDaemon(options: DaemonOptions): Promise<void> {
	logger.log("Starting Shellular daemon...");

	const activeLockData = getBootLockData();
	clearStaleLock();
	if (activeLockData && isBootLockActive(activeLockData)) {
		logger.log(chalk.yellow("Shellular CLI is already running."));
		writeLockDetails(activeLockData);
		const daemon = await withPm2(describeDaemon);
		if (daemon?.pm2_env?.status === "online") {
			const latestLogs = getLatestLogPaths();
			if (latestLogs) {
				await streamDaemonLogs(latestLogs);
			}
		}
		return;
	}

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
	} else {
		logger.warn(
			`Daemon status: ${chalk.yellow(status ?? "unknown")}. Streaming logs...`,
		);
	}

	await streamDaemonLogs(logs, offsets);
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

export async function stopDaemon(): Promise<void> {
	const stopped = await withPm2(async () => {
		const daemon = await describeDaemon();
		if (!daemon) {
			return false;
		}
		await deleteDaemon();
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

	logger.log(`PID: ${pid}`);
	logger.log(`Restarts: ${restarts}`);
	logger.log(`Memory: ${memory}`);

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

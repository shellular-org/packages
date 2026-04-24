import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import chalk from "chalk";

import { config } from "./config";
import { logger } from "./logger";

const lockFilePath = path.join(
	os.tmpdir(),
	`shellular-${config.MACHINE_ID}-${config.USERNAME}.lock`,
);

export type LockData = {
	pid: number;
	machineId: string;
	createdAt: string;
	serverUrl?: string;
	workDir?: string;
	connectionId?: string;
};

type BootLockMetadata = {
	serverUrl: string;
	workDir: string;
};

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readLockFile(): LockData | null {
	try {
		const raw = fs.readFileSync(lockFilePath, "utf8");
		const parsed = JSON.parse(raw) as LockData;
		return typeof parsed.pid === "number" ? parsed : null;
	} catch {
		return null;
	}
}

export function getBootLockData(): LockData | null {
	return readLockFile();
}

export function isBootLockActive(lock = readLockFile()): boolean {
	return Boolean(lock && isProcessAlive(lock.pid));
}

function writeLockFile(metadata: Partial<LockData>): void {
	const payload = JSON.stringify({
		pid: process.pid,
		machineId: config.MACHINE_ID,
		createdAt: new Date().toISOString(),
		...metadata,
	});

	try {
		const fd = fs.openSync(lockFilePath, "wx");
		fs.writeFileSync(fd, payload, "utf8");
		fs.closeSync(fd);
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "EEXIST"
		) {
			const existingLock = readLockFile();
			const existingPid = existingLock?.pid ?? null;

			if (existingPid && isProcessAlive(existingPid)) {
				logger.error("Shellular CLI is already running.");
				logger.error(
					`Existing process: ${chalk.yellow(existingPid.toString())}`,
				);

				if (existingLock?.connectionId) {
					logger.error(
						`Active connection: ${chalk.cyan(existingLock.connectionId)}`,
					);
				}

				if (existingLock?.serverUrl) {
					logger.error(`Server: ${chalk.white(existingLock.serverUrl)}`);
				}

				if (existingLock?.workDir) {
					logger.error(`Directory: ${chalk.white(existingLock.workDir)}`);
				}

				process.exit(1);
			}

			fs.rmSync(lockFilePath, { force: true });
			writeLockFile(metadata);
			return;
		}

		throw error;
	}
}

export function releaseBootLock(): void {
	const lockPid = readLockFile()?.pid ?? null;

	if (lockPid !== process.pid) {
		return;
	}

	logger.debug("Releasing boot lock...");
	fs.rmSync(lockFilePath, { force: true });
}

export function clearStaleLock(): void {
	const lock = readLockFile();
	if (lock && !isBootLockActive(lock)) {
		fs.rmSync(lockFilePath, { force: true });
	}
}

export function updateBootLock(
	metadata: Partial<Omit<LockData, "pid" | "machineId">>,
): void {
	const currentLock = readLockFile();

	if (!currentLock || currentLock.pid !== process.pid) {
		return;
	}

	fs.writeFileSync(
		lockFilePath,
		JSON.stringify({
			...currentLock,
			...metadata,
		}),
		"utf8",
	);
}

export function ensureSingleInstance(metadata: BootLockMetadata): void {
	writeLockFile(metadata);

	process.on("exit", () => {
		releaseBootLock();
	});

	process.on("SIGINT", () => {
		releaseBootLock();
	});

	process.on("SIGTERM", () => {
		releaseBootLock();
	});
}

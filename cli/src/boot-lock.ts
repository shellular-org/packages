import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import chalk from "chalk";
import { z } from "zod";

import { config } from "./config";
import { logger } from "./logger";

export const INSTANCE_CONTROL_PROTOCOL_VERSION = 1;
const MAX_MESSAGE_BYTES = 16 * 1024;
const ACTIVATION_TIMEOUT_MS = 15_000;

const instanceKey = crypto
	.createHash("sha256")
	.update(`${config.MACHINE_ID}:${config.USERNAME}`)
	.digest("hex")
	.slice(0, 24);
// Keep the original lock path so a new CLI can identify a live pre-activation
// CLI and return a useful update-required error instead of starting a duplicate.
const lockFilePath = path.join(
	os.tmpdir(),
	`shellular-${config.MACHINE_ID}-${config.USERNAME}.lock`,
);
const controlEndpoint =
	process.platform === "win32"
		? `\\\\.\\pipe\\shellular-${instanceKey}`
		: path.join(os.tmpdir(), `shellular-${instanceKey}.sock`);

export type LockData = {
	pid: number;
	machineId: string;
	instanceId?: string;
	createdAt: string;
	serverUrl?: string;
	workDir?: string;
	connectionId?: string;
	cliVersion?: string;
	localProtocolVersion?: number;
	localPort?: number;
	localEnabled?: boolean;
	activationProtocolVersion?: number;
	activationEndpoint?: string;
	activationSecret?: string;
	activationReady?: boolean;
};

export type BootLockMetadata = {
	serverUrl: string;
	workDir: string;
	localEnabled?: boolean;
	localProtocolVersion?: number;
	localPort?: number;
};

export type LocalActivationRequest = {
	port: number;
	token: string;
	source: "development" | "npx" | "global" | "attached" | "manual";
	ownerId?: string;
};

export type LocalActivationResult = {
	state: "started" | "already-running";
	pid: number;
	port: number;
	cliVersion: string;
	localProtocolVersion: number;
};

export class LocalActivationError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly currentVersion?: string,
	) {
		super(message);
		this.name = "LocalActivationError";
	}
}

const activationRequestSchema = z.object({
	type: z.literal("ACTIVATE_LOCAL"),
	protocolVersion: z.literal(INSTANCE_CONTROL_PROTOCOL_VERSION),
	requestId: z.string().min(1),
	targetInstanceId: z.string().min(1),
	secret: z.string().min(32),
	requiredLocalProtocolVersion: z.literal(1),
	port: z.number().int().min(0).max(65535),
	token: z.string().min(16),
	source: z.enum(["development", "npx", "global", "attached", "manual"]),
	ownerId: z.string().optional(),
});

type ActivationResponse =
	| ({ requestId: string; ok: true } & LocalActivationResult)
	| {
			requestId: string;
			ok: false;
			error: { code: string; message: string; currentVersion?: string };
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
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const parsed = JSON.parse(
				fs.readFileSync(lockFilePath, "utf8"),
			) as LockData;
			return typeof parsed.pid === "number" ? parsed : null;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		}
	}
	return null;
}

export function getBootLockData(): LockData | null {
	return readLockFile();
}

export function isBootLockActive(lock = readLockFile()): boolean {
	return Boolean(lock && isProcessAlive(lock.pid));
}

export async function waitForExistingInstance(
	timeoutMs: number,
): Promise<LockData | null> {
	const deadline = Date.now() + Math.max(0, timeoutMs);
	for (;;) {
		const lock = readLockFile();
		if (lock && isProcessAlive(lock.pid)) return lock;
		if (lock) removeStaleLock(lock);
		if (Date.now() >= deadline) return null;
		await wait(Math.min(100, deadline - Date.now()));
	}
}

function atomicWriteLock(data: LockData): void {
	const temporary = `${lockFilePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
	fs.renameSync(temporary, lockFilePath);
	fs.chmodSync(lockFilePath, 0o600);
}

function createLock(metadata: BootLockMetadata): LockData {
	const lock: LockData = {
		pid: process.pid,
		machineId: config.MACHINE_ID,
		instanceId: crypto.randomUUID(),
		createdAt: new Date().toISOString(),
		cliVersion: config.VERSION,
		activationProtocolVersion: INSTANCE_CONTROL_PROTOCOL_VERSION,
		activationEndpoint: controlEndpoint,
		activationSecret: crypto.randomBytes(32).toString("base64url"),
		activationReady: false,
		...metadata,
	};
	const fd = fs.openSync(lockFilePath, "wx", 0o600);
	try {
		fs.writeFileSync(fd, JSON.stringify(lock), "utf8");
	} finally {
		fs.closeSync(fd);
	}
	return lock;
}

function removeStaleLock(lock: LockData): boolean {
	const latest = readLockFile();
	if (
		!latest ||
		latest.pid !== lock.pid ||
		latest.instanceId !== lock.instanceId ||
		isProcessAlive(latest.pid)
	)
		return false;
	fs.rmSync(lockFilePath, { force: true });
	if (process.platform !== "win32" && latest.activationEndpoint) {
		try {
			fs.rmSync(latest.activationEndpoint, { force: true });
		} catch {}
	}
	return true;
}

export type InstanceClaim =
	| { kind: "owner"; lock: LockData }
	| { kind: "existing"; lock: LockData };

export function claimSingleInstance(metadata: BootLockMetadata): InstanceClaim {
	for (;;) {
		try {
			return { kind: "owner", lock: createLock(metadata) };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const existing = readLockFile();
			if (!existing) continue;
			if (isProcessAlive(existing.pid))
				return { kind: "existing", lock: existing };
			if (!removeStaleLock(existing)) continue;
		}
	}
}

export function reportExistingInstance(lock: LockData): void {
	logger.error("Shellular CLI is already running.");
	logger.error(`Existing process: ${chalk.yellow(lock.pid.toString())}`);
	if (lock.connectionId)
		logger.error(`Active connection: ${chalk.cyan(lock.connectionId)}`);
	if (lock.serverUrl) logger.error(`Server: ${chalk.white(lock.serverUrl)}`);
	if (lock.workDir) logger.error(`Directory: ${chalk.white(lock.workDir)}`);
}

export function releaseBootLock(): void {
	const lock = readLockFile();
	if (!lock || lock.pid !== process.pid) return;
	logger.debug("Releasing boot lock...");
	fs.rmSync(lockFilePath, { force: true });
}

export function clearStaleLock(): void {
	const lock = readLockFile();
	if (lock && !isProcessAlive(lock.pid)) removeStaleLock(lock);
}

export function updateBootLock(
	metadata: Partial<Omit<LockData, "pid" | "machineId" | "instanceId">>,
): void {
	const current = readLockFile();
	if (!current || current.pid !== process.pid) return;
	atomicWriteLock({ ...current, ...metadata });
}

function secureEqual(left: string, right: string): boolean {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function startInstanceControlServer(
	lock: LockData,
	handler: (request: LocalActivationRequest) => Promise<LocalActivationResult>,
): Promise<net.Server> {
	if (!lock.instanceId || !lock.activationEndpoint || !lock.activationSecret)
		throw new Error("Instance control metadata is missing");
	if (process.platform !== "win32")
		fs.rmSync(lock.activationEndpoint, { force: true });

	const server = net.createServer((socket) => {
		socket.setEncoding("utf8");
		let body = "";
		let handled = false;
		const respond = (response: ActivationResponse) => {
			if (socket.destroyed) return;
			socket.end(`${JSON.stringify(response)}\n`);
		};
		socket.on("data", (chunk) => {
			if (handled) return;
			body += chunk;
			if (Buffer.byteLength(body) > MAX_MESSAGE_BYTES) {
				handled = true;
				return respond({
					requestId: "unknown",
					ok: false,
					error: {
						code: "INVALID_REQUEST",
						message: "Activation request is too large",
					},
				});
			}
			const newline = body.indexOf("\n");
			if (newline < 0) return;
			handled = true;
			void (async () => {
				let requestId = "unknown";
				try {
					const request = activationRequestSchema.parse(
						JSON.parse(body.slice(0, newline)),
					);
					requestId = request.requestId;
					if (
						request.targetInstanceId !== lock.instanceId ||
						!secureEqual(request.secret, lock.activationSecret ?? "")
					)
						throw new LocalActivationError(
							"AUTHENTICATION_FAILED",
							"Invalid CLI activation credentials",
						);
					const result = await handler({
						port: request.port,
						token: request.token,
						source: request.source,
						ownerId: request.ownerId,
					});
					respond({ requestId, ok: true, ...result });
				} catch (error) {
					const activationError =
						error instanceof LocalActivationError
							? error
							: new LocalActivationError(
									"START_FAILED",
									error instanceof Error ? error.message : String(error),
								);
					respond({
						requestId,
						ok: false,
						error: {
							code: activationError.code,
							message: activationError.message,
							currentVersion: activationError.currentVersion,
						},
					});
				}
			})();
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(lock.activationEndpoint, resolve);
	});
	if (process.platform !== "win32")
		fs.chmodSync(lock.activationEndpoint, 0o600);
	updateBootLock({ activationReady: true });
	return server;
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendActivationOnce(
	lock: LockData,
	request: LocalActivationRequest,
): Promise<LocalActivationResult> {
	if (
		lock.activationProtocolVersion !== INSTANCE_CONTROL_PROTOCOL_VERSION ||
		!lock.instanceId ||
		!lock.activationEndpoint ||
		!lock.activationSecret
	)
		throw new LocalActivationError(
			"EXISTING_CLI_UNSUPPORTED",
			"The running Shellular CLI must be updated and restarted once to enable local access.",
			lock.cliVersion,
		);
	const requestId = crypto.randomUUID();
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(lock.activationEndpoint as string);
		const timer = setTimeout(() => {
			socket.destroy();
			reject(
				new LocalActivationError(
					"ACTIVATION_TIMEOUT",
					"Timed out enabling local access",
				),
			);
		}, 2_000);
		let body = "";
		const finish = (error?: Error, value?: LocalActivationResult) => {
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else if (value) resolve(value);
		};
		socket.setEncoding("utf8");
		socket.once("connect", () => {
			socket.write(
				`${JSON.stringify({
					type: "ACTIVATE_LOCAL",
					protocolVersion: INSTANCE_CONTROL_PROTOCOL_VERSION,
					requestId,
					targetInstanceId: lock.instanceId,
					secret: lock.activationSecret,
					requiredLocalProtocolVersion: 1,
					port: request.port,
					token: request.token,
					source: request.source,
					ownerId: request.ownerId,
				})}\n`,
			);
		});
		socket.on("data", (chunk) => {
			body += chunk;
			const newline = body.indexOf("\n");
			if (newline < 0) return;
			try {
				const response = JSON.parse(
					body.slice(0, newline),
				) as ActivationResponse;
				if (response.requestId !== requestId)
					throw new Error("Mismatched activation response");
				if (!response.ok)
					return finish(
						new LocalActivationError(
							response.error.code,
							response.error.message,
							response.error.currentVersion,
						),
					);
				finish(undefined, response);
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
		socket.once("error", (error) => finish(error));
	});
}

export async function activateExistingInstance(
	initialLock: LockData,
	request: LocalActivationRequest,
): Promise<LocalActivationResult> {
	const deadline = Date.now() + ACTIVATION_TIMEOUT_MS;
	let lastError: unknown;
	while (Date.now() < deadline) {
		const lock = readLockFile() ?? initialLock;
		if (!isProcessAlive(lock.pid))
			throw new LocalActivationError(
				"START_FAILED",
				"The running Shellular CLI exited during activation",
			);
		try {
			return await sendActivationOnce(lock, request);
		} catch (error) {
			if (
				error instanceof LocalActivationError &&
				error.code !== "ACTIVATION_TIMEOUT"
			)
				throw error;
			lastError = error;
			await wait(100);
		}
	}
	throw new LocalActivationError(
		"ACTIVATION_TIMEOUT",
		lastError instanceof Error
			? lastError.message
			: "Timed out enabling local access",
	);
}

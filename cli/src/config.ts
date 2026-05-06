import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodeMachineId from "node-machine-id";
import { z } from "zod";
import packageJson from "../package.json";
import { logger } from "./logger";
import type { ServerUrl } from "./server-url";
import { isErrnoException } from "./utils";

const filename =
	typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url);
const dirname =
	typeof __dirname === "string" ? __dirname : path.dirname(filename);

const SHELLULAR_DIR = path.resolve(os.homedir(), ".shellular");
const CONFIG_FILE = path.resolve(SHELLULAR_DIR, "config.json");

const username = os.userInfo().username.replace(/[^a-zA-Z0-9._-]/g, "_");
const machineId = nodeMachineId.machineIdSync();

const _config = {
	NAME: "shellular",
	VERSION: packageJson.version,
	DESCRIPTION: packageJson.description,
	SHELLULAR_DEV: process.env.SHELLULAR_DEV === "true",
	SHELLULAR_DIR,
	CONFIG_FILE,
	LOGS_DIR: path.join(SHELLULAR_DIR, "logs"),
	CLIENTS_FILE: path.join(SHELLULAR_DIR, "clients.json"),
	MACHINE_ID: machineId,
	PLATFORM: process.platform,
	USERNAME: username,
	HOSTNAME: os.hostname(),
	EXT_SRC_DIR: path.join(dirname, "..", "vscode-extension"),
	EXT_OUT_DIR: path.join(dirname, "..", "dist"),
} as const;

export function ensureConfig() {
	if (!fs.existsSync(_config.SHELLULAR_DIR)) {
		fs.mkdirSync(_config.SHELLULAR_DIR, { recursive: true });
	}

	if (!fs.existsSync(_config.LOGS_DIR)) {
		fs.mkdirSync(_config.LOGS_DIR, { recursive: true });
	}
}

const configFileSchema = z.object({
	hostId: z.string().optional(),
	machineId: z.string().optional(),
});

type ConfigFileData = z.infer<typeof configFileSchema>;

function readConfigFile(): ConfigFileData | null {
	try {
		const raw = fs.readFileSync(_config.CONFIG_FILE, "utf-8");
		const parsed = configFileSchema.safeParse(JSON.parse(raw));
		if (!parsed.success) {
			throw new Error(
				`Config file is invalid or corrupted: ${parsed.error.message}`,
			);
		}
		return parsed.data;
	} catch (err) {
		if (isErrnoException(err) && err.code === "ENOENT") {
			// config file doesn't exist yet - not an error, just means we need to register and create it
			return null;
		}

		throw err;
	}
}

const registerRespSchema = z.discriminatedUnion("success", [
	z.object({
		success: z.literal(true),
		data: z.object({
			hostId: z.string(),
		}),
	}),
	z.object({
		success: z.literal(false),
		error: z.string(),
	}),
]);

export async function getOrRegisterHostId(
	serverUrl: ServerUrl,
): Promise<string> {
	const existing = readConfigFile();
	if (existing) {
		if (existing.machineId && existing.machineId !== machineId) {
			throw new Error(
				"Machine ID mismatch — config file belongs to a different machine.",
			);
		}

		if (existing.hostId) {
			return existing.hostId;
		}
	}

	const url = serverUrl.toApiUrl({ path: "register" });
	logger.debug(`Registering host with server at ${url}`);
	const resp = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"User-Agent": `shellular/${_config.VERSION}`,
		},
		body: JSON.stringify({
			machineId: _config.MACHINE_ID,
			platform: _config.PLATFORM,
		}),
	});

	let data: unknown;
	try {
		data = await resp.json();
	} catch (err) {
		logger.error("Failed to parse registration response as JSON:", err);
		throw new Error(`Registration failed: ${resp.statusText}`);
	}

	const respJson = registerRespSchema.parse(data);

	if (!respJson.success) {
		throw new Error(`Registration error: ${resp.status} ${respJson.error}`);
	}

	const { hostId } = respJson.data;
	logger.log(`Registered host with ID: ${hostId}`);

	fs.writeFileSync(
		_config.CONFIG_FILE,
		JSON.stringify({ hostId, machineId: _config.MACHINE_ID }, null, 2),
		"utf-8",
	);

	return hostId;
}

export const config = {
	..._config,
};

export const npxCommand = config.PLATFORM === "win32" ? "npx.cmd" : "npx";

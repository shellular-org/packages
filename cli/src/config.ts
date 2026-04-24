import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodeMachineId from "node-machine-id";
import { z } from "zod";
import { logger } from "./logger";
import type { ServerUrl } from "./server-url";

const filename =
	typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url);
const dirname =
	typeof __dirname === "string" ? __dirname : path.dirname(filename);

const SHELLULAR_DIR = path.resolve(os.homedir(), ".shellular");
const CONFIG_FILE = path.resolve(SHELLULAR_DIR, "config.json");

const username = os.userInfo().username.replace(/[^a-zA-Z0-9._-]/g, "_");
const machineId = nodeMachineId.machineIdSync();
const platformName = os.platform();

const _config = {
	NAME: "shellular",
	SHELLULAR_DEV: process.env.SHELLULAR_DEV === "true",
	SHELLULAR_DIR,
	CONFIG_FILE,
	LOGS_DIR: path.join(SHELLULAR_DIR, "logs"),
	CLIENTS_FILE: path.join(SHELLULAR_DIR, "clients.json"),
	MACHINE_ID: machineId,
	PLATFORM: platformName,
	USERNAME: username,
	EXT_SRC_DIR: path.join(dirname, "..", "vscode-extension"),
	EXT_OUT_DIR: path.join(dirname, "..", "dist"),
};

export function ensureConfig() {
	if (!fs.existsSync(_config.SHELLULAR_DIR)) {
		fs.mkdirSync(_config.SHELLULAR_DIR, { recursive: true });
	}

	if (!fs.existsSync(_config.LOGS_DIR)) {
		fs.mkdirSync(_config.LOGS_DIR, { recursive: true });
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
		details: z.unknown().optional(),
	}),
]);

export async function getOrRegisterHostId(
	serverUrl: ServerUrl,
): Promise<string> {
	if (fs.existsSync(_config.CONFIG_FILE)) {
		const data = JSON.parse(fs.readFileSync(_config.CONFIG_FILE, "utf-8"));
		if (data.hostId && data.machineId === _config.MACHINE_ID) {
			return data.hostId;
		}
	}

	const url = serverUrl.toApiUrl({ path: "register" });
	logger.debug(`Registering host with server at ${url}`);
	const resp = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			machineId,
			platform: platformName,
		}),
	});

	if (!resp.ok) {
		throw new Error(`Registration failed: ${resp.statusText}`);
	}

	const respJson = registerRespSchema.parse(await resp.json());

	if ("error" in respJson) {
		logger.error("Registration error details:", respJson.details);
		throw new Error(`Registration error: ${respJson.error}`);
	}

	const { hostId } = respJson.data;
	logger.log(`Registered host with ID: ${hostId}`);

	try {
		fs.writeFileSync(
			CONFIG_FILE,
			JSON.stringify({ hostId, machineId }, null, 2),
		);
	} catch {
		logger.warn("Could not save hostId to file");
	}

	return hostId;
}

export const config = {
	..._config,
};

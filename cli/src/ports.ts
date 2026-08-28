import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	MsgType,
	type PortsKillResultMsg,
	type PortsListResultMsg,
} from "@shellular/protocol";

import { config } from "./config";
import type { HostConnection } from "./connection";
import { logger } from "./logger";

const { PLATFORM: platform } = config;

/**
 * Read portless's route registry and build a map of port → public URL.
 *
 * portless (https://portless.sh) assigns each dev server a `<name>.localhost`
 * URL and records the mapping in `routes.json` inside its state directory
 * (`~/.portless` by default, overridable via `PORTLESS_STATE_DIR`). Each entry
 * is `{ hostname, port, pid, ... }`, where `hostname` is already the full
 * `<name>.localhost` form, so we just prepend the scheme.
 *
 * Returns an empty map when portless isn't installed or the file is absent or
 * malformed — its absence simply means no port gets a portless URL.
 */
function readPortlessUrls(): Map<number, string> {
	const map = new Map<number, string>();
	const stateDir =
		process.env.PORTLESS_STATE_DIR || path.join(os.homedir(), ".portless");
	const routesPath = path.join(stateDir, "routes.json");
	if (!fs.existsSync(routesPath)) {
		return map;
	}

	try {
		const raw = fs.readFileSync(routesPath, "utf-8");
		const routes = JSON.parse(raw);
		if (!Array.isArray(routes)) {
			return map;
		}

		for (const route of routes) {
			if (
				route &&
				typeof route.hostname === "string" &&
				typeof route.port === "number"
			) {
				map.set(route.port, `https://${route.hostname}`);
			}
		}
	} catch (error) {
		logger.error("Failed to read portless routes:", error);
	}
	return map;
}

export function initPortsHandler(conn: HostConnection) {
	conn.on(MsgType.PORTS_LIST, (msg) => {
		const { clientId } = msg;

		const ports: Array<{
			port: number;
			pid: number;
			process: string;
			address: string;
			portlessUrl?: string;
		}> = [];

		try {
			let output: string;

			if (platform === "darwin" || platform === "linux") {
				try {
					output = execSync(
						"lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null || true",
						{
							encoding: "utf-8",
							timeout: 5000,
						},
					);

					const lines = output.trim().split("\n").slice(1);
					for (const line of lines) {
						const parts = line.split(/\s+/);
						if (parts.length >= 9) {
							const processName = parts[0];
							const pid = parseInt(parts[1], 10);
							const nameField = parts[8];
							const match = nameField.match(/:(\d+)$/);
							if (match) {
								const port = parseInt(match[1], 10);
								const address = nameField.replace(`:${port}`, "") || "0.0.0.0";
								ports.push({ port, pid, process: processName, address });
							}
						}
					}
				} catch {
					output = execSync(
						"netstat -tlnp 2>/dev/null || netstat -an 2>/dev/null || true",
						{
							encoding: "utf-8",
							timeout: 5000,
						},
					);
					// netstat parsing omitted for brevity in this iteration, fallback is empty or partially parsed
				}
			} else if (platform === "win32") {
				output = execSync("netstat -ano | findstr LISTENING", {
					encoding: "utf-8",
					timeout: 5000,
				});

				const lines = output.trim().split("\n");
				for (const line of lines) {
					const parts = line.trim().split(/\s+/);
					if (parts.length >= 5) {
						const localAddr = parts[1];
						const pid = parseInt(parts[4], 10);
						const match = localAddr.match(/:(\d+)$/);
						if (match) {
							const port = parseInt(match[1], 10);
							const address = localAddr.replace(`:${port}`, "");
							ports.push({ port, pid, process: "unknown", address });
						}
					}
				}
			}

			const ignoreProcessSet = new Set([
				"ControlCe", // macOS internal networking ports
				"Code\\x20H", // VS Code Helper (truncated on macOS)
				"rapportd", // macOS Remote Management
			]);

			const ignorePortsSet = new Set([
				22, // SSH
				23, // Telnet
				3389, // microsoft RDP
				7265, // raycast
			]);

			// Attach portless URLs where the user has mapped a port to a
			// `<name>.localhost` host. Only ports present in portless's registry
			// get a URL; the rest are left untouched.
			const portlessUrls = readPortlessUrls();
			if (portlessUrls.size > 0) {
				for (const p of ports) {
					const url = portlessUrls.get(p.port);
					if (url) {
						p.portlessUrl = url;
					}
				}
			}

			const respMsg: PortsListResultMsg = {
				type: MsgType.PORTS_LIST_RESULT,
				clientId,
				respTo: msg.id,
				data: {
					ports: ports.filter(
						(p) =>
							!ignoreProcessSet.has(p.process) && !ignorePortsSet.has(p.port),
					),
				},
			};
			conn.send(respMsg);
		} catch (error) {
			conn.send({
				type: MsgType.PORTS_LIST_RESULT,
				clientId,
				respTo: msg.id,
				error: error instanceof Error ? error.message : "Failed to list ports",
			});
		}
	});

	conn.on(MsgType.PORTS_KILL, (msg) => {
		const { clientId } = msg;
		const port = msg.data.port;

		const portNum = Math.floor(Number(port));
		if (!Number.isFinite(portNum) || portNum < 1 || portNum > 65535) {
			conn.send({
				type: MsgType.PORTS_KILL_RESULT,
				clientId,
				respTo: msg.id,
				error: "port must be an integer between 1 and 65535",
			});
			return;
		}

		let pid: number | null = null;

		try {
			if (platform === "darwin" || platform === "linux") {
				const result = spawnSync("lsof", ["-ti", String(portNum)], {
					encoding: "utf-8",
				});
				const pids = (result.stdout || "").trim().split("\n").filter(Boolean);
				for (const pidStr of pids) {
					const p = parseInt(pidStr, 10);
					if (!Number.isFinite(p) || p <= 0) continue;
					if (pid === null) pid = p;
					try {
						process.kill(p, "SIGKILL");
					} catch {
						// already dead
					}
				}
			} else if (platform === "win32") {
				const result = spawnSync("netstat", ["-ano"], { encoding: "utf-8" });
				const lines = (result.stdout || "").trim().split("\n");
				for (const line of lines) {
					if (!line.includes("LISTENING")) continue;
					const parts = line.trim().split(/\s+/);
					if (parts.length >= 5) {
						const localAddr = parts[1];
						const p = parseInt(parts[4], 10);
						if (localAddr.endsWith(`:${portNum}`)) {
							if (pid === null) pid = p;
							spawnSync("taskkill", ["/F", "/PID", String(p)]);
						}
					}
				}
			}

			const respMsg: PortsKillResultMsg = {
				type: MsgType.PORTS_KILL_RESULT,
				clientId,
				respTo: msg.id,
				data: { port: portNum, pid },
			};
			conn.send(respMsg);
		} catch (error) {
			conn.send({
				type: MsgType.PORTS_KILL_RESULT,
				clientId,
				respTo: msg.id,
				error: error instanceof Error ? error.message : "Failed to kill port",
			});
		}
	});
}

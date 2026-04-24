import { execSync, spawnSync } from "node:child_process";
import os from "node:os";
import {
	MsgType,
	type PortsKillResultMsg,
	type PortsListResultMsg,
} from "@shellular/protocol";
import type { Connection } from "./connection";

export function initPortsHandler(conn: Connection) {
	conn.on(MsgType.PORTS_LIST, (msg) => {
		const { clientId } = msg;
		const platform = os.platform();
		const ports: Array<{
			port: number;
			pid: number;
			process: string;
			address: string;
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

			const ignoreSet = new Set([
				"ControlCe", // macOS internal networking ports
				"Code\\x20H", // VS Code Helper (truncated on macOS)
				"rapportd", // macOS Remote Management
			]);

			const respMsg: PortsListResultMsg = {
				type: MsgType.PORTS_LIST_RESULT,
				clientId,
				respTo: msg.id,
				data: {
					ports: ports.filter((p) => !ignoreSet.has(p.process)),
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

		const platform = os.platform();
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

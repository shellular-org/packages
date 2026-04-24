import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";

import type { Connection } from "./connection";
import {
	type BatteryUpdateMsg,
	MsgType,
	type SysmonResultMsg,
} from "@shellular/protocol";

const execFileAsync = promisify(execFile);

async function sampleCpuUsage(): Promise<number> {
	const start = os.cpus();
	await new Promise((resolve) => setTimeout(resolve, 200));
	const end = os.cpus();

	let idle = 0;
	let total = 0;

	for (let i = 0; i < start.length; i++) {
		const startTimes = start[i].times;
		const endTimes = end[i].times;
		const idleDelta = endTimes.idle - startTimes.idle;
		const totalDelta =
			endTimes.user -
			startTimes.user +
			(endTimes.nice - startTimes.nice) +
			(endTimes.sys - startTimes.sys) +
			(endTimes.irq - startTimes.irq) +
			idleDelta;

		idle += idleDelta;
		total += totalDelta;
	}

	if (total <= 0) return 0;
	return Math.round((1 - idle / total) * 100 * 10) / 10;
}

async function getStorage() {
	if (process.platform === "win32") {
		return [] as Array<{
			mount: string;
			total: number;
			used: number;
			free: number;
		}>;
	}

	try {
		const { stdout } = await execFileAsync("df", ["-kP"]);
		return stdout
			.trim()
			.split("\n")
			.slice(1)
			.map((line) => line.trim().split(/\s+/))
			.filter((parts) => parts.length >= 6)
			.map((parts) => {
				const [, totalKb, usedKb, freeKb, , mount] = parts;
				const total = Number(totalKb) * 1024;
				const used = Number(usedKb) * 1024;
				const free = Number(freeKb) * 1024;
				return {
					mount,
					total,
					used,
					free,
				};
			})
			.filter(
				(entry) =>
					entry.mount &&
					Number.isFinite(entry.total) &&
					Number.isFinite(entry.used) &&
					Number.isFinite(entry.free),
			);
	} catch {
		return [];
	}
}

async function getBattery(): Promise<{
	percentage: number;
	charging: boolean;
} | null> {
	try {
		if (process.platform === "darwin") {
			const { stdout } = await execFileAsync("pmset", ["-g", "batt"]);
			const percentMatch = stdout.match(/(\d+)%/);
			if (!percentMatch) return null;
			const percentage = Number(percentMatch[1]);
			const charging = /\bcharging\b/i.test(stdout);
			return { percentage, charging };
		}

		if (process.platform === "linux") {
			const supplyDir = "/sys/class/power_supply";
			const entries = await fs.readdir(supplyDir).catch(() => [] as string[]);
			const batEntry = entries.find((e) => e.startsWith("BAT"));
			if (!batEntry) return null;
			const base = `${supplyDir}/${batEntry}`;
			const [capacityStr, statusStr] = await Promise.all([
				fs.readFile(`${base}/capacity`, "utf-8").catch(() => null),
				fs.readFile(`${base}/status`, "utf-8").catch(() => null),
			]);
			if (capacityStr === null) return null;
			const percentage = Number(capacityStr.trim());
			const charging = statusStr?.trim().toLowerCase() === "charging";
			return { percentage, charging };
		}

		return null;
	} catch {
		return null;
	}
}

const BATTERY_INTERVAL_MS = 30_000;

export function initBatteryStream(conn: Connection) {
	const intervals = new Map<string, ReturnType<typeof setInterval>>();

	async function sendBattery(clientId: string) {
		const battery = await getBattery();
		if (!battery) return;
		const msg: BatteryUpdateMsg = {
			type: MsgType.BATTERY_UPDATE,
			clientId,
			data: battery,
		};
		conn.send(msg);
	}

	conn.on(MsgType.SESSION_CLIENT_JOINED, (msg) => {
		const { clientId } = msg.data;
		sendBattery(clientId);
		const interval = setInterval(
			() => sendBattery(clientId),
			BATTERY_INTERVAL_MS,
		);
		intervals.set(clientId, interval);
	});

	conn.on(MsgType.SESSION_CLIENT_LEFT, (msg) => {
		const interval = intervals.get(msg.data.clientId);
		if (interval) {
			clearInterval(interval);
			intervals.delete(msg.data.clientId);
		}
	});
}

export function initSysmonHandler(conn: Connection) {
	conn.on(MsgType.SYSMON_GET, async (msg) => {
		try {
			const cpus = os.cpus();
			const total = os.totalmem();
			const free = os.freemem();
			const respMsg: SysmonResultMsg = {
				type: MsgType.SYSMON_RESULT,
				clientId: msg.clientId,
				respTo: msg.id,
				data: {
					cpu: {
						model: cpus[0]?.model ?? "Unknown CPU",
						cores: cpus.length,
						usage: await sampleCpuUsage(),
					},
					memory: {
						total,
						used: total - free,
						free,
					},
					storage: await getStorage(),
					uptime: os.uptime(),
				},
			};
			conn.send(respMsg);
		} catch (err) {
			const respMsg: SysmonResultMsg = {
				type: MsgType.SYSMON_RESULT,
				clientId: msg.clientId,
				respTo: msg.id,
				error:
					err instanceof Error ? err.message : "Failed to fetch system info",
			};
			conn.send(respMsg);
		}
	});
}

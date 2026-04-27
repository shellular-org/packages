import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import {
	type BatteryUpdateMsg,
	MsgType,
	type SysmonResultMsg,
} from "@shellular/protocol";
import type { Connection } from "./connection";

const execFileAsync = promisify(execFile);

type MemoryStats = {
	total: number;
	used: number;
	available: number;
	free: number;
	usage: number;
};

type StorageEntry = {
	label: string;
	mount: string;
	total: number;
	used: number;
	free: number;
	usage: number;
};

function toUsage(used: number, total: number): number {
	if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0;
	return Math.max(0, Math.min(100, Math.round((used / total) * 1000) / 10));
}

function clampBytes(value: number, total: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(total, Math.round(value)));
}

function parseMeminfo(content: string): Record<string, number> {
	return content.split("\n").reduce<Record<string, number>>((acc, line) => {
		const match = line.match(/^([^:]+):\s+(\d+)\s+kB$/);
		if (!match) return acc;
		acc[match[1]] = Number(match[2]) * 1024;
		return acc;
	}, {});
}

function parseVmStatBytes(content: string): Record<string, number> {
	const pageSizeMatch = content.match(/page size of (\d+) bytes/i);
	const pageSize = Number(pageSizeMatch?.[1] ?? 4096);
	const stats: Record<string, number> = {};

	for (const line of content.split("\n")) {
		const match = line.match(/^([^:]+):\s+([\d.]+)/);
		if (!match) continue;
		stats[match[1]] = Number(match[2].replace(/\.$/, "")) * pageSize;
	}

	return stats;
}

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

async function getMemory(): Promise<MemoryStats> {
	const total = os.totalmem();
	const fallbackFree = os.freemem();
	const fallbackAvailable = clampBytes(fallbackFree, total);

	try {
		if (process.platform === "linux") {
			const meminfo = parseMeminfo(await fs.readFile("/proc/meminfo", "utf-8"));
			const available = clampBytes(
				meminfo.MemAvailable ?? meminfo.MemFree ?? fallbackAvailable,
				total,
			);
			const free = clampBytes(meminfo.MemFree ?? available, total);
			const used = clampBytes(total - available, total);
			return {
				total,
				used,
				available,
				free,
				usage: toUsage(used, total),
			};
		}

		if (process.platform === "darwin") {
			const [{ stdout: vmStatStdout }, { stdout: memSizeStdout }] =
				await Promise.all([
					execFileAsync("vm_stat"),
					execFileAsync("sysctl", ["-n", "hw.memsize"]),
				]);
			const vmStats = parseVmStatBytes(vmStatStdout);
			const platformTotal = Number(memSizeStdout.trim()) || total;
			const free = clampBytes(
				vmStats["Pages free"] ?? fallbackFree,
				platformTotal,
			);
			const available = clampBytes(
				(vmStats["Pages free"] ?? 0) +
					(vmStats["Pages inactive"] ?? 0) +
					(vmStats["Pages speculative"] ?? 0) +
					(vmStats["Pages purgeable"] ?? 0),
				platformTotal,
			);
			const used = clampBytes(platformTotal - available, platformTotal);
			return {
				total: platformTotal,
				used,
				available,
				free,
				usage: toUsage(used, platformTotal),
			};
		}
	} catch {
		// Fall back to Node's coarse memory view if platform-specific sampling fails.
	}

	const used = clampBytes(total - fallbackAvailable, total);
	return {
		total,
		used,
		available: fallbackAvailable,
		free: fallbackAvailable,
		usage: toUsage(used, total),
	};
}

function getStorageLabel(mount: string): string {
	if (mount === "/System/Volumes/Data") return "Mac Storage";
	if (mount === "/") return "System";
	if (mount === "/home") return "Home";
	if (mount.startsWith("/Volumes/")) return mount.split("/").pop() || mount;
	if (mount.startsWith("/mnt/") || mount.startsWith("/media/")) {
		return mount.split("/").pop() || mount;
	}
	return mount.split("/").filter(Boolean).pop() || mount;
}

function isRelevantStorageMount(mount: string): boolean {
	if (!mount) return false;

	if (process.platform === "darwin") {
		if (mount === "/" || mount === "/System/Volumes/Data") return true;
		if (mount.startsWith("/Volumes/")) return true;
		return false;
	}

	if (process.platform === "linux") {
		if (mount === "/" || mount === "/home") return true;
		if (mount.startsWith("/mnt/") || mount.startsWith("/media/")) return true;
		if (
			mount.startsWith("/proc") ||
			mount.startsWith("/sys") ||
			mount.startsWith("/dev") ||
			mount.startsWith("/run") ||
			mount.startsWith("/snap")
		) {
			return false;
		}
	}

	return !(
		mount.startsWith("/private/var/run") ||
		mount.startsWith("/System/Volumes/Preboot") ||
		mount.startsWith("/System/Volumes/Update") ||
		mount.startsWith("/System/Volumes/VM") ||
		mount.startsWith("/Volumes/com.apple")
	);
}

function rankStorageMount(mount: string): number {
	if (mount === "/System/Volumes/Data") return 0;
	if (mount === "/") return 1;
	if (mount === "/home") return 2;
	if (mount.startsWith("/Volumes/")) return 3;
	if (mount.startsWith("/mnt/") || mount.startsWith("/media/")) return 4;
	return 5;
}

async function getStorage(): Promise<StorageEntry[]> {
	if (process.platform === "win32") {
		return [];
	}

	try {
		const { stdout } = await execFileAsync("df", ["-kP"]);
		const parsed = stdout
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
					label: getStorageLabel(mount),
					mount,
					total,
					used,
					free,
					usage: toUsage(used, total),
				};
			})
			.filter(
				(entry) =>
					entry.mount &&
					Number.isFinite(entry.total) &&
					Number.isFinite(entry.used) &&
					Number.isFinite(entry.free) &&
					entry.total > 0,
			);

		const relevant = parsed.filter((entry) =>
			isRelevantStorageMount(entry.mount),
		);
		const preferred = relevant.length > 0 ? relevant : parsed;
		const deduped =
			process.platform === "darwin" &&
			preferred.some((entry) => entry.mount === "/System/Volumes/Data")
				? preferred.filter((entry) => entry.mount !== "/")
				: preferred;

		return deduped
			.sort(
				(a, b) =>
					rankStorageMount(a.mount) - rankStorageMount(b.mount) ||
					b.total - a.total,
			)
			.slice(0, 4);
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
			const [cpuUsage, memory, storage] = await Promise.all([
				sampleCpuUsage(),
				getMemory(),
				getStorage(),
			]);
			const respMsg: SysmonResultMsg = {
				type: MsgType.SYSMON_RESULT,
				clientId: msg.clientId,
				respTo: msg.id,
				data: {
					cpu: {
						model: cpus[0]?.model.replace(/\s+/g, " ").trim() || "Unknown CPU",
						cores: cpus.length,
						usage: cpuUsage,
					},
					memory,
					storage,
					uptime: os.uptime(),
					recordedAt: Date.now(),
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

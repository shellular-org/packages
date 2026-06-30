import { spawn } from "node:child_process";
import fs from "node:fs";

import { config, getSelfUpdateLogPath, npxCommand } from "@/config";
import { isShellularInstalledGlobally } from "@/update-and-start";

/**
 * Quote a single argv token for a POSIX `sh -c` string. We wrap in single
 * quotes and escape any embedded single quote the usual `'\''` way.
 */
function shQuote(token: string): string {
	return `'${token.replace(/'/g, `'\\''`)}'`;
}

export async function runSelfUpdate(): Promise<void> {
	const isInstalledGlobally = await isShellularInstalledGlobally();

	const command = isInstalledGlobally ? "shellular" : npxCommand;
	const args = isInstalledGlobally
		? ["__update_and_start"]
		: ["-y", "shellular", "__update_and_start"];

	// The worker is detached + orphaned, so its stdio can't go to this daemon's
	// terminal. Redirect it to a fresh timestamped log file (one per run, so
	// history is kept) so the whole update — npm install, stop, start — is
	// captured for debugging. List them with `shellular logs --self-updates`.
	const logPath = getSelfUpdateLogPath();
	const header =
		`\n===== self-update started ${new Date().toISOString()} =====\n` +
		`command: ${command} ${args.join(" ")}\n` +
		`cwd: ${config.SHELLULAR_DIR}\n` +
		`PATH: ${process.env.PATH ?? ""}\n\n`;
	fs.writeFileSync(logPath, header);
	const logFd = fs.openSync(logPath, "a");

	// CRITICAL: the update worker must NOT remain a PID-descendant of this
	// daemon. The worker runs `shellular stop`, which does `pm2.delete`, and PM2
	// tree-kills (SIGTERM) every descendant of the daemon it tears down. A plain
	// `detached` spawn still leaves the worker in the daemon's child tree until
	// the daemon dies, so PM2 kills it mid-`stop` (seen in logs as
	// "exited ... signal SIGTERM", and the update never reaches `start`).
	//
	// To escape, we reparent the worker to init (PID 1) BEFORE it touches PM2:
	// launch it via an intermediate `sh -c` that backgrounds the real command
	// (`& exit`). The intermediate shell exits immediately, so the real update
	// process is orphaned to PID 1 and is no longer in the daemon's tree by the
	// time `pm2.delete` walks it.
	if (process.platform === "win32") {
		// Windows has no `pm2 treekill`-by-tree concern in the same way; a plain
		// detached spawn is sufficient (and there's no POSIX `sh` to reparent
		// through). Keep the original detached behavior here.
		const child = spawn(command, args, {
			detached: true,
			stdio: ["ignore", logFd, logFd],
			cwd: config.SHELLULAR_DIR,
			env: process.env,
		});
		child.unref();
	} else {
		const innerCmd = [command, ...args].map(shQuote).join(" ");
		// `&` backgrounds the real worker; the wrapper `sh` then exits, orphaning
		// the worker to init. stdio of both is the log fd.
		const child = spawn("/bin/sh", ["-c", `${innerCmd} &`], {
			detached: true,
			stdio: ["ignore", logFd, logFd],
			cwd: config.SHELLULAR_DIR,
			env: process.env,
		});
		child.unref();
	}

	// The child has its own dup'd fd now; close ours so this daemon doesn't hold
	// the file open after it exits.
	fs.closeSync(logFd);
}

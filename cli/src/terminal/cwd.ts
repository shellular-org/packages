import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolveNewTerminalCwd(
	workDir: string,
	requestedCwd?: string,
): string {
	return requestedCwd ? path.resolve(workDir, requestedCwd) : os.homedir();
}

export function resolveRestoredTerminalCwd(savedCwd?: string): string {
	return savedCwd && fs.existsSync(savedCwd) ? savedCwd : os.homedir();
}

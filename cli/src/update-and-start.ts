import { spawn } from "node:child_process";

import { getBootLockData } from "@/boot-lock";
import { config, npxCommand } from "@/config";
import { logger } from "@/logger";
import { getUpdateInfo } from "@/update-check";
import { flatten } from "@/utils";

function runCommand(cmd: string, args: string[], log = false): Promise<void> {
	return new Promise((resolve, reject) => {
		if (log) {
			logger.log(`Running command: ${cmd} ${args.join(" ")}`);
		}

		const child = spawn(cmd, args, {
			stdio: "inherit",
			shell: process.platform === "win32", // ensures Windows compatibility
		});

		child.on("close", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
			}
		});

		child.on("error", reject);
	});
}

export function isShellularInstalledGlobally(): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn("npm", ["list", "-g", "shellular", "--depth=0"], {
			stdio: "ignore",
			shell: process.platform === "win32",
		});

		child.on("close", (code) => {
			resolve(code === 0);
		});

		child.on("error", () => {
			resolve(false);
		});
	});
}

export async function updateAndStartShellular(): Promise<void> {
	const isInstalledGlobally = await isShellularInstalledGlobally();

	const bootLockData = getBootLockData();
	const options: Record<string, string> = {};
	if (bootLockData?.serverUrl) {
		options["--server"] = bootLockData.serverUrl;
	}
	if (bootLockData?.workDir) {
		options["--dir"] = bootLockData.workDir;
	}

	const optionsArgs = flatten(Object.entries(options));

	// Resolve the exact version to install instead of relying on the `@latest`
	// Pinning to `@<version>` (e.g.`shellular@0.0.41`) is unambiguous
	// and forces the right copy every time.
	const { latest } = await getUpdateInfo(config.VERSION);
	if (!latest) {
		throw new Error(
			"Could not resolve the latest Shellular version from npm; aborting update.",
		);
	}
	const spec = `shellular@${latest}`;
	logger.log(`Resolved latest version: ${latest}`);

	if (isInstalledGlobally) {
		// update to the resolved version globally
		await runCommand("npm", ["install", "-g", spec], true);

		// log the updated version
		await runCommand("shellular", ["--version"], true);

		// stop the daemon if it's running
		await runCommand("shellular", ["stop"], true);

		// start the daemon
		await runCommand(
			"shellular",
			[...optionsArgs, "start", "--no-log-stream"],
			true,
		);
	} else {
		// stop in case it's running
		await runCommand(npxCommand, ["shellular", "stop"], true);

		// update and log the updated version
		await runCommand(npxCommand, ["-y", spec, "--version"], true);

		// start the daemon from the resolved (pinned) version
		await runCommand(
			npxCommand,
			["-y", spec, ...optionsArgs, "start", "--no-log-stream"],
			true,
		);
	}
}

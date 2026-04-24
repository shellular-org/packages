import { type ChildProcess, spawn } from "node:child_process";
import process from "node:process";

import { logger } from "./logger";

let caffeinateProc: ChildProcess | null = null;

export function startCaffeinate() {
	if (process.platform !== "darwin") {
		return;
	}

	if (caffeinateProc) {
		return;
	}

	// https://ss64.com/mac/caffeinate.html
	caffeinateProc = spawn("caffeinate", ["-i"], {
		detached: true,
		stdio: "ignore",
	});

	caffeinateProc.on("error", (err) => {
		logger.debug(`caffeinate failed: ${err.message}`);
		caffeinateProc = null;
	});

	caffeinateProc.unref();
	logger.debug("caffeinate started to prevent system sleep");
}

export function stopCaffeinate() {
	if (!caffeinateProc) {
		return;
	}

	try {
		caffeinateProc.kill();
	} catch (err) {
		logger.error("Failed to stop caffeinate process:", err);
	}

	caffeinateProc = null;
	logger.debug("caffeinate stopped");
}

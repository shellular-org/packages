import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import chalk from "chalk";

import { config } from "@/config";
import { logger } from "@/logger";
import { streamFile } from "@/utils";

/** Self-update log files (newest first), produced by the detached worker. */
function getSelfUpdateLogFiles(): string[] {
	try {
		return fs
			.readdirSync(config.SELF_UPDATE_LOGS_DIR)
			.filter((f) => f.endsWith(".log"))
			.sort()
			.reverse()
			.map((f) => path.join(config.SELF_UPDATE_LOGS_DIR, f));
	} catch {
		return [];
	}
}

export async function showSelfUpdateLogs(): Promise<void> {
	const files = getSelfUpdateLogFiles();
	if (files.length === 0) {
		logger.log("No self-update logs found.");
		return;
	}

	logger.log(chalk.bold(`Self-update logs (${files.length}):`));
	files.forEach((file, i) => {
		const marker = i === 0 ? chalk.green(" (latest)") : "";
		logger.log(`  ${chalk.dim(file)}${marker}`);
	});
	logger.log();

	// Stream the latest from offset 0 — these are short, single-file logs, so
	// show the whole thing. Streaming (not a one-shot read) means that if an
	// update is in flight, new output appears live until Ctrl+C.
	const latest = files[0];
	logger.log(chalk.bold(`── latest: ${path.basename(latest)} ──`));
	logger.log(chalk.dim("Press Ctrl+C to exit."));

	const handle = streamFile(latest, 0, process.stdout);
	await new Promise<void>((resolve) => {
		const stop = () => {
			handle.stop();
			resolve();
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
	});
}

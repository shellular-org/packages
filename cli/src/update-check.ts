import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import semver from "semver";
import { config } from "./config";
import { logger } from "./logger";

const NPM_REGISTRY_URL = "https://registry.npmjs.org/shellular";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STATE_FILE = path.join(config.SHELLULAR_DIR, "update-check.json");

interface UpdateCheckState {
	lastChecked: number;
}

function loadState(): UpdateCheckState {
	try {
		const raw = fs.readFileSync(STATE_FILE, "utf-8");
		return JSON.parse(raw) as UpdateCheckState;
	} catch {
		return { lastChecked: 0 };
	}
}

function saveState(state: UpdateCheckState): void {
	try {
		fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
	} catch {
		// ignore write failures
	}
}

export async function checkForUpdate(currentVersion: string): Promise<void> {
	const state = loadState();
	const now = Date.now();

	if (now - state.lastChecked < CHECK_INTERVAL_MS) {
		return;
	}

	try {
		const resp = await fetch(NPM_REGISTRY_URL, {
			headers: { "Accept-Encoding": "identity" },
			signal: AbortSignal.timeout(5000),
		});

		if (!resp.ok) return;

		const data = (await resp.json()) as { "dist-tags": { latest: string } };
		const latestVersion = data["dist-tags"]?.latest;
		if (!latestVersion) return;

		saveState({ lastChecked: now });

		if (semver.gt(latestVersion, currentVersion)) {
			logger.log(
				"\n" +
					chalk.yellow.bold("╭──────────────────────────────────────╮") +
					"\n" +
					chalk.yellow.bold("│") +
					"  " +
					chalk.yellow.bold("Update available!") +
					" " +
					chalk.dim(`${currentVersion} → ${latestVersion}`) +
					"     " +
					chalk.yellow.bold("│") +
					"\n" +
					chalk.yellow.bold("│") +
					"  " +
					chalk.cyan("Run: npx shellular@latest") +
					"           " +
					chalk.yellow.bold("│") +
					"\n" +
					chalk.yellow.bold("╰──────────────────────────────────────╯") +
					"\n",
			);
		}
	} catch {
		// silent — update check should never block or annoy
	}
}

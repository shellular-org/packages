import chalk from "chalk";
import semver from "semver";
import { z } from "zod";
import { LocalCache } from "./local-cache";
import { logger } from "./logger";

const NPM_REGISTRY_URL = "https://registry.npmjs.org/shellular";
/**
 * Single cadence for the npm "latest version" lookup. The in-memory TTL cache
 * is the only throttle: a fetched version stays fresh for this long, so both
 * the startup banner and the per-client handshake re-check at most once an hour
 * and a long-lived daemon eventually sees newly published versions.
 */
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export interface UpdateInfo {
	/** The currently running CLI version. */
	current: string;
	/** Latest version published on npm, when the lookup succeeded. */
	latest?: string;
	/** True when `latest` is strictly newer than `current`. */
	updateAvailable: boolean;
}

/**
 * Fetch the latest published version from npm. Returns undefined on any failure
 * (network error, timeout, malformed response) so callers can fall back safely.
 */
async function fetchLatestVersion(): Promise<string | undefined> {
	try {
		const resp = await fetch(NPM_REGISTRY_URL, {
			headers: { "Accept-Encoding": "identity" },
			signal: AbortSignal.timeout(5000),
		});
		if (!resp.ok) {
			return undefined;
		}

		const data = (await resp.json()) as { "dist-tags"?: { latest?: string } };
		return data["dist-tags"]?.latest;
	} catch {
		return undefined;
	}
}

// TTL cache so the handshake path and the startup banner share a single lookup
// instead of hitting npm twice on launch, while still re-checking periodically
// so a long-lived daemon eventually sees newly published versions.
const latestVersionCache = new LocalCache<string>({
	ttlMs: CHECK_INTERVAL_MS,
	schema: z.string(),
});
const LATEST_VERSION_KEY = "latest";

async function getLatestVersionCached(): Promise<string | undefined> {
	return latestVersionCache.getOrFetch(LATEST_VERSION_KEY, fetchLatestVersion);
}

/**
 * Resolve update info for the given version. Best-effort: never throws, and
 * returns `updateAvailable: false` with no `latest` when the lookup fails.
 */
export async function getUpdateInfo(
	currentVersion: string,
): Promise<UpdateInfo> {
	const latest = await getLatestVersionCached();
	const updateAvailable =
		!!latest &&
		semver.valid(latest) !== null &&
		semver.gt(latest, currentVersion);
	return { current: currentVersion, latest, updateAvailable };
}

export async function checkForUpdate(currentVersion: string): Promise<void> {
	// The TTL cache throttles the actual npm request, so this can be called
	// freely; it only re-fetches once the cached version goes stale (1 hour).
	const latestVersion = await getLatestVersionCached();
	if (!latestVersion) return;

	if (semver.valid(latestVersion) && semver.gt(latestVersion, currentVersion)) {
		logger.log(
			"\n" +
				chalk.yellow.bold("╭───────────────────────────────────────────╮") +
				"\n" +
				chalk.yellow.bold("│") +
				"  " +
				chalk.yellow.bold("Update available!") +
				" " +
				chalk.dim(`${currentVersion} → ${latestVersion}`) +
				"        " +
				chalk.yellow.bold("│") +
				"\n" +
				chalk.yellow.bold("│") +
				"        " +
				chalk.cyan("Run: npx shellular@latest") +
				"          " +
				chalk.yellow.bold("│") +
				"\n" +
				chalk.yellow.bold("╰───────────────────────────────────────────╯") +
				"\n",
		);
	}
}

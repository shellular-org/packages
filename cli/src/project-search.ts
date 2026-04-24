import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { FileFinder } from "@ff-labs/fff-node";
import type { GitStatus } from "@shellular/protocol";

import { computeEntryGitStatus, findGitRoot, getFileGitStatuses } from "./git";

type FinderEntry = {
	finder: FileFinder;
	scan: Promise<void>;
	lastUsed: number;
};

export type ProjectSearchEntry = {
	name: string;
	path: string;
	relativePath: string;
	type: "directory" | "file";
	size: number;
	modified: number;
	gitStatus?: GitStatus | null;
	score?: {
		total: number;
		matchType: string;
		exactMatch: boolean;
		filenameBonus: number;
		frecencyBoost: number;
		comboMatchBoost: number;
	};
};

export type ProjectSearchStatus = {
	isScanning: boolean;
	scannedFilesCount: number;
	indexedFiles?: number;
	diagnostics?: {
		nativeAvailable: boolean;
		gitAvailable?: boolean;
		repositoryFound?: boolean;
		issues: string[];
	};
};

export type ProjectSearchResult = {
	entries: ProjectSearchEntry[];
	history: string[];
	status: ProjectSearchStatus;
};

type ProjectSearchOptions = {
	limit?: number;
	selectedPath?: string;
	includeHistory?: boolean;
	refresh?: boolean;
};

const finderCache = new Map<string, FinderEntry>();
const FINDER_IDLE_MS = 10 * 60 * 1000;
const HISTORY_LIMIT = 5;

function pruneFinders() {
	const now = Date.now();
	for (const [basePath, entry] of finderCache) {
		if (now - entry.lastUsed <= FINDER_IDLE_MS) continue;
		entry.finder.destroy();
		finderCache.delete(basePath);
	}
}

function dbPathFor(basePath: string, suffix: string): string {
	const hash = createHash("sha1").update(basePath).digest("hex");
	const dir = path.resolve(os.homedir(), ".shellular", "fff");
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	return path.join(dir, `${hash}-${suffix}.mdb`);
}

async function getFinder(basePath: string): Promise<FinderEntry> {
	pruneFinders();
	const cached = finderCache.get(basePath);
	if (cached && !cached.finder.isDestroyed) {
		cached.lastUsed = Date.now();
		return cached;
	}

	const { FileFinder } = await import("@ff-labs/fff-node");
	const created = FileFinder.create({
		basePath,
		frecencyDbPath: dbPathFor(basePath, "frecency"),
		historyDbPath: dbPathFor(basePath, "history"),
		disableMmapCache: true,
		disableContentIndexing: true,
	});
	if (!created.ok) {
		throw new Error(created.error);
	}

	const finder = created.value;
	const entry: FinderEntry = {
		finder,
		lastUsed: Date.now(),
		scan: finder.waitForScan(1500).then((result) => {
			if (!result.ok) throw new Error(result.error);
		}),
	};
	finderCache.set(basePath, entry);
	return entry;
}

function normalizeRelativePath(relativePath: string): string {
	return relativePath.replace(/\/+$/, "");
}

function mapGitStatus(status?: GitStatus | null): GitStatus | null {
	return status ?? null;
}

function getHistory(finder: FileFinder): string[] {
	const history: string[] = [];
	for (let offset = 0; offset < HISTORY_LIMIT; offset++) {
		const result = finder.getHistoricalQuery(offset);
		if (!result.ok || !result.value) continue;
		if (!history.includes(result.value)) history.push(result.value);
	}
	return history;
}

function getStatus(finder: FileFinder): ProjectSearchStatus {
	const scanProgress = finder.getScanProgress();
	const health = finder.healthCheck();
	const issues: string[] = [];

	if (!health.ok) {
		issues.push(health.error);
	} else {
		if (health.value.git.error) issues.push(health.value.git.error);
		if (health.value.filePicker.error)
			issues.push(health.value.filePicker.error);
		if (health.value.frecency.error) issues.push(health.value.frecency.error);
		if (health.value.queryTracker.error) {
			issues.push(health.value.queryTracker.error);
		}
	}

	return {
		isScanning: scanProgress.ok
			? scanProgress.value.isScanning
			: finder.isScanning(),
		scannedFilesCount: scanProgress.ok
			? scanProgress.value.scannedFilesCount
			: 0,
		indexedFiles: health.ok ? health.value.filePicker.indexedFiles : undefined,
		diagnostics: {
			nativeAvailable: true,
			gitAvailable: health.ok ? health.value.git.available : undefined,
			repositoryFound: health.ok ? health.value.git.repositoryFound : undefined,
			issues,
		},
	};
}

export async function searchProjectFiles(
	basePath: string,
	query: string,
	options: ProjectSearchOptions = {},
): Promise<ProjectSearchResult> {
	const trimmedQuery = query.trim();
	const limit = options.limit ?? 40;

	const finderEntry = await getFinder(basePath);
	if (options.refresh) {
		finderEntry.finder.reindex(basePath);
		finderEntry.finder.refreshGitStatus();
		finderEntry.scan = finderEntry.finder.waitForScan(1500).then((result) => {
			if (!result.ok) throw new Error(result.error);
		});
	}
	await finderEntry.scan;
	finderEntry.lastUsed = Date.now();

	if (trimmedQuery && options.selectedPath) {
		finderEntry.finder.trackQuery(
			trimmedQuery,
			normalizeRelativePath(path.relative(basePath, options.selectedPath)),
		);
	}

	const history = options.includeHistory ? getHistory(finderEntry.finder) : [];
	const status = getStatus(finderEntry.finder);
	if (!trimmedQuery) return { entries: [], history, status };

	const search = finderEntry.finder.mixedSearch(trimmedQuery, {
		pageIndex: 0,
		pageSize: limit,
	});
	if (!search.ok) {
		throw new Error(search.error);
	}

	const repoRoot = await findGitRoot(basePath);
	const statuses = repoRoot
		? await getFileGitStatuses(repoRoot, basePath)
		: new Map<string, GitStatus>();
	const entries: ProjectSearchEntry[] = [];

	for (const [index, result] of search.value.items.entries()) {
		const relativePath = normalizeRelativePath(result.item.relativePath);
		if (!relativePath) continue;

		const fullPath = path.join(basePath, relativePath);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(fullPath);
		} catch {
			continue;
		}

		const type = stat.isDirectory() ? "directory" : "file";
		const score = search.value.scores[index];
		entries.push({
			name: path.basename(fullPath),
			path: fullPath,
			relativePath,
			type,
			size: stat.size,
			modified: stat.mtimeMs,
			gitStatus: mapGitStatus(
				repoRoot
					? computeEntryGitStatus(statuses, repoRoot, fullPath, type)
					: null,
			),
			score: score
				? {
						total: score.total,
						matchType: score.matchType,
						exactMatch: score.exactMatch,
						filenameBonus: score.filenameBonus,
						frecencyBoost: score.frecencyBoost,
						comboMatchBoost: score.comboMatchBoost,
					}
				: undefined,
		});
	}

	return {
		entries,
		history,
		status: {
			...status,
			indexedFiles: search.value.totalFiles,
		},
	};
}

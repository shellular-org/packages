import fs from "node:fs";
import path from "node:path";

import type { GitStatus, ProjectTreeResultMsg } from "@shellular/protocol";
import { nanoid } from "nanoid";

import { computeEntryGitStatus, findGitRoot, getFileGitStatuses } from "./git";

export type ProjectTreeEntry = NonNullable<
	NonNullable<ProjectTreeResultMsg["data"]>["entries"]
>[number];

type Snapshot = {
	id: string;
	path: string;
	lastAccessedAt: number;
	entries: ProjectTreeEntry[];
};

export type ProjectTreePage = {
	snapshotId: string;
	entries: ProjectTreeEntry[];
	nextCursor?: number;
};

const DEFAULT_PAGE_SIZE = 2000;
const MIN_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 5000;
const DEFAULT_TTL_MS = 2 * 60 * 1000;
const DEFAULT_MAX_PROJECTS = 8;
const YIELD_EVERY = 250;

const EXCLUDED_NAMES = new Set([".git", ".DS_Store"]);

export async function scanProjectTree(
	projectPath: string,
): Promise<ProjectTreeEntry[]> {
	const entries: ProjectTreeEntry[] = [];
	let visited = 0;

	const walk = async (directory: string, relativeDirectory: string) => {
		const handle = await fs.promises.opendir(directory);
		const children: fs.Dirent[] = [];
		for await (const entry of handle) {
			if (!EXCLUDED_NAMES.has(entry.name)) children.push(entry);
		}
		children.sort(compareDirectoryEntries);

		for (const entry of children) {
			const relativePath = toPosixPath(
				relativeDirectory
					? path.join(relativeDirectory, entry.name)
					: entry.name,
			);
			const isDirectory = entry.isDirectory() && !entry.isSymbolicLink();
			entries.push({
				relativePath,
				type: isDirectory ? "directory" : "file",
			});
			visited++;
			if (visited % YIELD_EVERY === 0) await yieldToEventLoop();
			if (isDirectory) {
				await walk(path.join(directory, entry.name), relativePath);
			}
		}
	};

	await walk(projectPath, "");
	await attachGitStatuses(projectPath, entries);
	return entries;
}

export class ProjectTreeSnapshotStore {
	private readonly snapshots = new Map<string, Snapshot>();
	private readonly currentByPath = new Map<string, string>();
	private readonly builds = new Map<string, Promise<Snapshot>>();
	private readonly versions = new Map<string, number>();

	constructor(
		private readonly options: {
			ttlMs?: number;
			maxProjects?: number;
			now?: () => number;
		} = {},
	) {}

	async page(
		projectPath: string,
		request: {
			snapshotId?: string;
			cursor?: number;
			pageSize?: number;
			refresh?: boolean;
		},
		build: (path: string) => Promise<ProjectTreeEntry[]> = scanProjectTree,
	): Promise<ProjectTreePage> {
		this.prune();
		if (request.refresh) {
			this.versions.set(projectPath, (this.versions.get(projectPath) ?? 0) + 1);
			this.removeProject(projectPath);
			this.builds.delete(projectPath);
		}

		const snapshot = request.snapshotId
			? this.getSnapshot(request.snapshotId, projectPath)
			: await this.getOrBuild(projectPath, build);
		snapshot.lastAccessedAt = this.now();
		const cursor = Math.max(0, request.cursor ?? 0);
		const pageSize = Math.min(
			MAX_PAGE_SIZE,
			Math.max(MIN_PAGE_SIZE, request.pageSize ?? DEFAULT_PAGE_SIZE),
		);
		const end = Math.min(snapshot.entries.length, cursor + pageSize);
		return {
			snapshotId: snapshot.id,
			entries: snapshot.entries.slice(cursor, end),
			...(end < snapshot.entries.length ? { nextCursor: end } : {}),
		};
	}

	private getSnapshot(snapshotId: string, projectPath: string) {
		const snapshot = this.snapshots.get(snapshotId);
		if (!snapshot || snapshot.path !== projectPath) {
			throw new Error("Project tree snapshot expired; refresh and try again.");
		}
		snapshot.lastAccessedAt = this.now();
		return snapshot;
	}

	private async getOrBuild(
		projectPath: string,
		build: (path: string) => Promise<ProjectTreeEntry[]>,
	) {
		const currentId = this.currentByPath.get(projectPath);
		if (currentId) {
			const current = this.snapshots.get(currentId);
			if (current) {
				current.lastAccessedAt = this.now();
				return current;
			}
		}
		const existingBuild = this.builds.get(projectPath);
		if (existingBuild) return existingBuild;

		const version = this.versions.get(projectPath) ?? 0;
		const pending = build(projectPath)
			.then((entries) => {
				const now = this.now();
				const snapshot: Snapshot = {
					id: nanoid(12),
					path: projectPath,
					lastAccessedAt: now,
					entries,
				};
				if ((this.versions.get(projectPath) ?? 0) === version) {
					this.removeProject(projectPath);
					this.snapshots.set(snapshot.id, snapshot);
					this.currentByPath.set(projectPath, snapshot.id);
					this.prune();
				}
				return snapshot;
			})
			.finally(() => {
				if (this.builds.get(projectPath) === pending) {
					this.builds.delete(projectPath);
				}
			});
		this.builds.set(projectPath, pending);
		return pending;
	}

	private removeProject(projectPath: string) {
		const currentId = this.currentByPath.get(projectPath);
		if (currentId) this.snapshots.delete(currentId);
		this.currentByPath.delete(projectPath);
	}

	private prune() {
		const cutoff = this.now() - (this.options.ttlMs ?? DEFAULT_TTL_MS);
		for (const snapshot of this.snapshots.values()) {
			if (snapshot.lastAccessedAt < cutoff) this.removeProject(snapshot.path);
		}
		const maximum = this.options.maxProjects ?? DEFAULT_MAX_PROJECTS;
		const ordered = [...this.snapshots.values()].sort(
			(left, right) => left.lastAccessedAt - right.lastAccessedAt,
		);
		for (const snapshot of ordered.slice(
			0,
			Math.max(0, ordered.length - maximum),
		)) {
			this.removeProject(snapshot.path);
		}
	}

	private now() {
		return this.options.now?.() ?? Date.now();
	}
}

function compareDirectoryEntries(left: fs.Dirent, right: fs.Dirent) {
	const leftDirectory = left.isDirectory() && !left.isSymbolicLink();
	const rightDirectory = right.isDirectory() && !right.isSymbolicLink();
	if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;
	return left.name.localeCompare(right.name, undefined, {
		numeric: true,
		sensitivity: "base",
	});
}

async function attachGitStatuses(
	projectPath: string,
	entries: ProjectTreeEntry[],
) {
	const repoRoot = await findGitRoot(projectPath);
	if (!repoRoot) return;
	const statuses = await getFileGitStatuses(repoRoot, projectPath);
	for (const entry of entries) {
		const status = computeEntryGitStatus(
			statuses,
			repoRoot,
			path.join(projectPath, entry.relativePath),
			entry.type,
		) as GitStatus | null;
		if (status) entry.gitStatus = status;
	}
}

function toPosixPath(value: string) {
	return value.split(path.sep).join("/");
}

function yieldToEventLoop() {
	return new Promise<void>((resolve) => setImmediate(resolve));
}

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { ProjectTreeSnapshotStore, scanProjectTree } from "./project-tree";

let project = "";

before(async () => {
	project = await mkdtemp(path.join(tmpdir(), "shellular-project-tree-"));
	await mkdir(path.join(project, ".git"));
	await mkdir(path.join(project, ".config"));
	await mkdir(path.join(project, "src", "nested"), { recursive: true });
	await writeFile(path.join(project, ".DS_Store"), "ignored");
	await writeFile(path.join(project, ".config", "app.json"), "{}");
	await writeFile(path.join(project, "src", "2-file.ts"), "two");
	await writeFile(path.join(project, "src", "10-file.ts"), "ten");
	await writeFile(path.join(project, "README.md"), "readme");
	await symlink(path.join(project, "src"), path.join(project, "src-link"));
});

after(async () => {
	if (project) await rm(project, { recursive: true, force: true });
});

test("scans a stable VS Code-like project tree without following symlinks", async () => {
	const entries = await scanProjectTree(project);
	assert.deepEqual(
		entries.map(({ relativePath, type }) => [relativePath, type]),
		[
			[".config", "directory"],
			[".config/app.json", "file"],
			["src", "directory"],
			["src/nested", "directory"],
			["src/2-file.ts", "file"],
			["src/10-file.ts", "file"],
			["README.md", "file"],
			["src-link", "file"],
		],
	);
	assert.equal(
		entries.some((entry) => entry.relativePath.includes(".git")),
		false,
	);
	assert.equal(
		entries.some((entry) => entry.relativePath === ".DS_Store"),
		false,
	);
});

test("paginates and deduplicates concurrent snapshot builds", async () => {
	const store = new ProjectTreeSnapshotStore();
	let builds = 0;
	const build = async () => {
		builds++;
		await Promise.resolve();
		return Array.from({ length: 230 }, (_, index) => ({
			relativePath: `file-${index}.txt`,
			type: "file" as const,
		}));
	};
	const [first, duplicate] = await Promise.all([
		store.page(project, { pageSize: 100 }, build),
		store.page(project, { pageSize: 100 }, build),
	]);
	assert.equal(builds, 1);
	assert.equal(first.snapshotId, duplicate.snapshotId);
	assert.equal(first.entries.length, 100);
	assert.equal(first.nextCursor, 100);

	const last = await store.page(
		project,
		{ snapshotId: first.snapshotId, cursor: 200, pageSize: 100 },
		build,
	);
	assert.equal(last.entries.length, 30);
	assert.equal(last.nextCursor, undefined);
});

test("rejects expired snapshot cursors", async () => {
	let now = 10;
	const store = new ProjectTreeSnapshotStore({ ttlMs: 5, now: () => now });
	const first = await store.page(project, {}, async () => []);
	now = 20;
	await assert.rejects(
		store.page(project, { snapshotId: first.snapshotId, cursor: 1 }),
		/snapshot expired/i,
	);
});

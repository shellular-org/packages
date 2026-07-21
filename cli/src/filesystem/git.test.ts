import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { getWorkingTreeFileDiff, runGitOperation } from "./git";

let repository = "";

function git(...args: string[]) {
	execFileSync("git", args, { cwd: repository, stdio: "pipe" });
}

before(async () => {
	repository = await mkdtemp(path.join(tmpdir(), "shellular-git-diff-"));
	git("init", "--initial-branch=main");
	git("config", "user.name", "Shellular Test");
	git("config", "user.email", "test@shellular.local");
	await writeFile(path.join(repository, "partial.txt"), "head\n");
	await writeFile(path.join(repository, "old-name.txt"), "rename me\n");
	await writeFile(path.join(repository, "deleted.txt"), "delete me\n");
	git("add", ".");
	git("commit", "-m", "initial");
});

after(async () => {
	if (repository) await rm(repository, { recursive: true, force: true });
});

test("returns distinct staged and unstaged comparisons for partially staged files", async () => {
	await writeFile(path.join(repository, "partial.txt"), "index\n");
	git("add", "partial.txt");
	await writeFile(path.join(repository, "partial.txt"), "worktree\n");

	const staged = await getWorkingTreeFileDiff(
		repository,
		"partial.txt",
		"head-to-index",
	);
	assert.deepEqual(staged, {
		path: "partial.txt",
		oldText: "head\n",
		newText: "index\n",
		binary: false,
	});

	const unstaged = await getWorkingTreeFileDiff(
		repository,
		"partial.txt",
		"index-to-worktree",
	);
	assert.deepEqual(unstaged, {
		path: "partial.txt",
		oldText: "index\n",
		newText: "worktree\n",
		binary: false,
	});
});

test("uses an empty comparison side for untracked files", async () => {
	await writeFile(path.join(repository, "untracked.txt"), "new file\n");
	const diff = await getWorkingTreeFileDiff(
		repository,
		"untracked.txt",
		"index-to-worktree",
	);
	assert.deepEqual(diff, {
		path: "untracked.txt",
		oldText: "",
		newText: "new file\n",
		binary: false,
	});
});

test("resolves the HEAD side of staged renames from the original path", async () => {
	git("mv", "old-name.txt", "new-name.txt");
	const diff = await getWorkingTreeFileDiff(
		repository,
		"new-name.txt",
		"head-to-index",
	);
	assert.deepEqual(diff, {
		path: "new-name.txt",
		oldText: "rename me\n",
		newText: "rename me\n",
		binary: false,
	});
});

test("returns empty sides for staged additions and deletions", async () => {
	await writeFile(path.join(repository, "added.txt"), "added\n");
	git("add", "added.txt");
	const added = await getWorkingTreeFileDiff(
		repository,
		"added.txt",
		"head-to-index",
	);
	assert.equal(added?.oldText, "");
	assert.equal(added?.newText, "added\n");

	git("rm", "deleted.txt");
	const deleted = await getWorkingTreeFileDiff(
		repository,
		"deleted.txt",
		"head-to-index",
	);
	assert.equal(deleted?.oldText, "delete me\n");
	assert.equal(deleted?.newText, "");
});

test("marks binary comparisons safely", async () => {
	await writeFile(
		path.join(repository, "binary.dat"),
		new Uint8Array([0, 1, 2]),
	);
	git("add", "binary.dat");
	const diff = await getWorkingTreeFileDiff(
		repository,
		"binary.dat",
		"head-to-index",
	);
	assert.equal(diff?.binary, true);
});

test("permanently removes explicitly discarded untracked files", async () => {
	const target = path.join(repository, "discard-me.txt");
	await writeFile(target, "temporary\n");
	await runGitOperation(repository, "discard", { files: ["discard-me.txt"] });
	await assert.rejects(access(target));
});

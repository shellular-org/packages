import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { resolveNewTerminalCwd, resolveRestoredTerminalCwd } from "./cwd";

const existingCwd = fs.mkdtempSync(
	path.join(os.tmpdir(), "shellular-terminal-cwd-"),
);
const missingCwd = path.join(existingCwd, "deleted");

after(() => {
	fs.rmSync(existingCwd, { force: true, recursive: true });
});

test("new terminals default to the host home independently of workDir", () => {
	const filesystemRoot = path.parse(process.cwd()).root;
	const alternateWorkDir = path.join(os.tmpdir(), "shellular-workdir");

	assert.equal(resolveNewTerminalCwd(filesystemRoot), os.homedir());
	assert.equal(resolveNewTerminalCwd(alternateWorkDir), os.homedir());
});

test("explicit terminal directories preserve absolute and relative behavior", () => {
	const workDir = path.join(os.tmpdir(), "shellular-workdir");
	const absoluteProject = path.join(os.tmpdir(), "shellular-project");

	assert.equal(
		resolveNewTerminalCwd(workDir, absoluteProject),
		absoluteProject,
	);
	assert.equal(
		resolveNewTerminalCwd(workDir, "relative-project"),
		path.resolve(workDir, "relative-project"),
	);
});

test("restored terminals keep valid directories and fall back home when missing", () => {
	assert.equal(resolveRestoredTerminalCwd(existingCwd), existingCwd);
	assert.equal(resolveRestoredTerminalCwd(missingCwd), os.homedir());
});

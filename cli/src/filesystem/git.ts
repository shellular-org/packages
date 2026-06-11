import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type { GitCommit, GitCommitFile, GitStatus } from "@shellular/protocol";

const execFileAsync = promisify(execFile);

function normalizeGitPath(filePath: string): string {
	return filePath.replace(/\\/g, "/");
}

async function execGit(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd });
	// Only strip the trailing newline(s); do NOT trim leading whitespace, since
	// porcelain status lines begin with a significant space (e.g. " M path").
	return stdout.replace(/\n+$/, "");
}

export async function findGitRoot(dir: string): Promise<string | null> {
	try {
		const result = await execGit(["rev-parse", "--show-toplevel"], dir);
		return result || null;
	} catch {
		return null;
	}
}

export async function getFileGitStatuses(
	repoRoot: string,
	targetPath: string,
): Promise<Map<string, GitStatus>> {
	const statusMap = new Map<string, GitStatus>();
	const relTargetPath = path.relative(repoRoot, targetPath);
	const targetPathSpec = relTargetPath === "" ? "." : relTargetPath;

	let output: string;
	try {
		output = await execGit(
			[
				"status",
				"--porcelain=v1",
				"-u",
				"--ignored=matching",
				"--",
				`${targetPathSpec}/`,
			],
			repoRoot,
		);
	} catch {
		return statusMap;
	}

	if (!output) return statusMap;

	for (const rawLine of output.split("\n")) {
		if (!rawLine) continue;
		const X = rawLine[0];
		const Y = rawLine[1];
		// File path starts at index 3 (after "XY ")
		let filePath = rawLine.slice(3);

		// Handle renames: "R  old -> new"
		if (X === "R") {
			const arrowIdx = filePath.indexOf(" -> ");
			if (arrowIdx !== -1) {
				filePath = filePath.slice(arrowIdx + 4);
			}
		}

		filePath = normalizeGitPath(filePath);

		let status: GitStatus;
		if (X === "?" && Y === "?") {
			status = "untracked";
		} else if (X === "!" && Y === "!") {
			status = "ignored";
		} else if (Y === "M") {
			status = "modified";
		} else if (Y === "D") {
			status = "deleted";
		} else if (X === "A") {
			status = "added";
		} else if (X === "R" && Y === " ") {
			status = "staged";
		} else if (X === "R") {
			status = "renamed";
		} else if (X !== " " && Y === " ") {
			// Staged change with no worktree modification (M or D staged)
			status = "staged";
		} else {
			status = "modified";
		}

		statusMap.set(filePath, status);
	}

	return statusMap;
}

const GIT_STATUS_PRIORITY: GitStatus[] = [
	"staged",
	"modified",
	"added",
	"deleted",
	"renamed",
	"untracked",
	"ignored",
];

export function computeEntryGitStatus(
	statuses: Map<string, GitStatus>,
	repoRoot: string,
	entryAbsPath: string,
	entryType: "file" | "directory",
): GitStatus | null {
	const relPath = path
		.normalize(path.relative(repoRoot, entryAbsPath))
		.replace(/\\/g, "/");

	if (entryType === "file") {
		return statuses.get(relPath) ?? null;
	}

	// For directories: collect statuses of all files under this prefix.
	// Use forward slashes (git's format) for consistent cross-platform matching.
	// Exclude "ignored" status since a single ignored file like .DS_Store
	// should not cause an entire directory to appear greyed out.
	const prefix = relPath.endsWith("/") ? relPath : `${relPath}/`;
	const found = new Set<GitStatus>();
	for (const [filePath, status] of statuses) {
		if (
			status !== "ignored" &&
			(filePath.startsWith(prefix) || filePath === relPath)
		) {
			found.add(status);
		}
	}

	if (found.size === 0) return null;

	for (const s of GIT_STATUS_PRIORITY) {
		if (found.has(s)) return s;
	}

	return null;
}

export type ProjectGitInfo =
	| { hasGit: false }
	| {
			hasGit: true;
			branch: string;
			ahead: number;
			behind: number;
			staged: number;
			unstaged: number;
			untracked: number;
	  };

export async function getProjectGitInfo(
	projectPath: string,
): Promise<ProjectGitInfo> {
	const root = await findGitRoot(projectPath);
	if (!root) return { hasGit: false };

	try {
		const countLines = (s: string): number =>
			s ? s.split("\n").filter(Boolean).length : 0;

		const [
			branch,
			aheadStr,
			behindStr,
			stagedOutput,
			unstagedOutput,
			untrackedOutput,
		] = await Promise.all([
			execGit(["rev-parse", "--abbrev-ref", "HEAD"], projectPath).catch(
				() => "HEAD",
			),
			execGit(["rev-list", "@{u}..HEAD", "--count"], projectPath).catch(
				() => "0",
			),
			execGit(["rev-list", "HEAD..@{u}", "--count"], projectPath).catch(
				() => "0",
			),
			execGit(["diff", "--cached", "--name-only"], projectPath).catch(() => ""),
			execGit(["diff", "--name-only"], projectPath).catch(() => ""),
			execGit(
				["ls-files", "--others", "--exclude-standard"],
				projectPath,
			).catch(() => ""),
		]);

		return {
			hasGit: true,
			branch,
			ahead: Number(aheadStr) || 0,
			behind: Number(behindStr) || 0,
			staged: countLines(stagedOutput),
			unstaged: countLines(unstagedOutput),
			untracked: countLines(untrackedOutput),
		};
	} catch {
		return { hasGit: false };
	}
}

// ─── Commit history ──────────────────────────────────────────────────────────

// Field separator (unit separator, 0x1f) used inside each --pretty record so we
// can split fields safely even when commit subjects contain spaces or arrows.
const GIT_LOG_FIELD_SEP = "\x1f";
const DEFAULT_LOG_LIMIT = 30;
const MAX_LOG_LIMIT = 100;

export interface GitLogPage {
	commits: GitCommit[];
	hasMore: boolean;
	total: number;
}

/**
 * Return a page of commits from HEAD's history, newest first.
 * Records are NUL-delimited and fields are 0x1f-delimited so that commit
 * subjects with arbitrary characters (newlines, quotes, " -> ") parse cleanly.
 */
export async function getGitLog(
	projectPath: string,
	options: { skip?: number; limit?: number } = {},
): Promise<GitLogPage> {
	const root = await findGitRoot(projectPath);
	if (!root) return { commits: [], hasMore: false, total: 0 };

	const skip = Math.max(0, Math.floor(options.skip ?? 0));
	const limit = Math.min(
		MAX_LOG_LIMIT,
		Math.max(1, Math.floor(options.limit ?? DEFAULT_LOG_LIMIT)),
	);

	// Total commit count; an empty repo (no commits) makes this fail → 0.
	const totalStr = await execGit(
		["rev-list", "--count", "HEAD"],
		projectPath,
	).catch(() => "0");
	const total = Number(totalStr) || 0;
	if (total === 0) return { commits: [], hasMore: false, total: 0 };

	const format = ["%H", "%h", "%an", "%ae", "%at", "%s"].join(
		GIT_LOG_FIELD_SEP,
	);

	let output: string;
	try {
		output = await execGit(
			[
				"-c",
				"log.showSignature=false",
				"log",
				`--pretty=format:${format}`,
				"-z",
				`--skip=${skip}`,
				`--max-count=${limit}`,
			],
			projectPath,
		);
	} catch {
		return { commits: [], hasMore: false, total };
	}

	const commits: GitCommit[] = [];
	for (const record of output.split("\0")) {
		if (!record) continue;
		const fields = record.split(GIT_LOG_FIELD_SEP);
		if (fields.length < 6) continue;
		const [hash, shortHash, author, email, atStr, ...rest] = fields;
		commits.push({
			hash,
			shortHash,
			author,
			email,
			timestamp: Number(atStr) || 0,
			// Re-join in case a subject ever contained the separator byte.
			subject: rest.join(GIT_LOG_FIELD_SEP),
		});
	}

	return {
		commits,
		hasMore: skip + commits.length < total,
		total,
	};
}

function diffStatusToGitStatus(statusCode: string): GitStatus {
	// diff-tree status is a single letter, optionally followed by a score
	// (e.g. "R100"). We only care about the leading letter.
	switch (statusCode[0]) {
		case "A":
			return "added";
		case "D":
			return "deleted";
		case "R":
			return "renamed";
		default:
			return "modified";
	}
}

/**
 * Return the files changed in a single commit. The hash is validated against a
 * strict pattern to avoid passing arbitrary tokens to git.
 */
export async function getCommitFiles(
	projectPath: string,
	hash: string,
): Promise<GitCommitFile[]> {
	if (!/^[0-9a-f]{7,40}$/i.test(hash)) return [];

	const root = await findGitRoot(projectPath);
	if (!root) return [];

	let output: string;
	try {
		output = await execGit(
			["diff-tree", "--no-commit-id", "--name-status", "-r", "-z", hash],
			projectPath,
		);
	} catch {
		return [];
	}

	// NUL-delimited stream of alternating <status> <path> tokens. For renames
	// (R<score>) git emits <status> <oldPath> <newPath>; we keep the new path.
	const tokens = output.split("\0").filter((t) => t.length > 0);
	const files: GitCommitFile[] = [];
	let i = 0;
	while (i < tokens.length) {
		const statusCode = tokens[i];
		const isRename = statusCode[0] === "R" || statusCode[0] === "C";
		if (isRename) {
			// status, oldPath, newPath
			const newPath = tokens[i + 2];
			if (newPath) {
				files.push({
					path: normalizeGitPath(newPath),
					status: diffStatusToGitStatus(statusCode),
				});
			}
			i += 3;
		} else {
			const filePath = tokens[i + 1];
			if (filePath) {
				files.push({
					path: normalizeGitPath(filePath),
					status: diffStatusToGitStatus(statusCode),
				});
			}
			i += 2;
		}
	}

	return files;
}

const MAX_DIFF_FILE_BYTES = 2 * 1024 * 1024;

export interface GitCommitFileDiff {
	oldText: string;
	newText: string;
	/** True when either side looks binary; the texts are then empty. */
	binary: boolean;
}

/**
 * Read a single file's contents before and after a commit so the client can
 * render a diff. `rev:path` resolves the blob at that revision; the parent
 * revision (`rev^`) gives the "before" side. A missing blob on either side
 * (added/deleted file, or root commit with no parent) is treated as empty.
 */
export async function getCommitFileDiff(
	projectPath: string,
	hash: string,
	filePath: string,
): Promise<GitCommitFileDiff | null> {
	if (!/^[0-9a-f]{7,40}$/i.test(hash)) return null;

	const root = await findGitRoot(projectPath);
	if (!root) return null;

	const relPath = normalizeGitPath(filePath);

	const showBlob = async (rev: string): Promise<Buffer> => {
		try {
			const { stdout } = await execFileAsync(
				"git",
				["show", `${rev}:${relPath}`],
				{
					cwd: projectPath,
					encoding: "buffer",
					maxBuffer: MAX_DIFF_FILE_BYTES,
				},
			);
			return stdout;
		} catch {
			// Blob absent at this revision (added/deleted file or no parent).
			return Buffer.alloc(0);
		}
	};

	const [oldBuf, newBuf] = await Promise.all([
		showBlob(`${hash}^`),
		showBlob(hash),
	]);

	if (isBinaryBuffer(oldBuf) || isBinaryBuffer(newBuf)) {
		return { oldText: "", newText: "", binary: true };
	}

	return {
		oldText: oldBuf.toString("utf-8"),
		newText: newBuf.toString("utf-8"),
		binary: false,
	};
}

function isBinaryBuffer(buf: Buffer): boolean {
	// A NUL byte in the first 8KB is git's own heuristic for "binary".
	const sample = buf.subarray(0, Math.min(buf.length, 8000));
	return sample.includes(0);
}

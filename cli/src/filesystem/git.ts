import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type {
	GitBranch,
	GitCommit,
	GitCommitFile,
	GitOperation,
	GitStatus,
	GitWorkingTreeFile,
	GitWorkingTreeFileDiff,
	GitWorkingTreeStatus,
} from "@shellular/protocol";

const execFileAsync = promisify(execFile);
const gitRootCache = new Map<string, string>();
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

function normalizeGitPath(filePath: string): string {
	return filePath.replace(/\\/g, "/");
}

async function execGit(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		maxBuffer: MAX_GIT_OUTPUT_BYTES,
	});
	// Only strip the trailing newline(s); do NOT trim leading whitespace, since
	// porcelain status lines begin with a significant space (e.g. " M path").
	return stdout.replace(/\n+$/, "");
}

async function execGitWithOutput(args: string[], cwd: string): Promise<string> {
	const { stdout, stderr } = await execFileAsync("git", args, {
		cwd,
		maxBuffer: MAX_GIT_OUTPUT_BYTES,
	});
	return [stdout, stderr].filter(Boolean).join("\n").replace(/\n+$/, "");
}

export async function findGitRoot(dir: string): Promise<string | null> {
	const cached = gitRootCache.get(dir);
	if (cached) return cached;
	try {
		const result = await execGit(["rev-parse", "--show-toplevel"], dir);
		if (result) {
			gitRootCache.set(dir, result);
			gitRootCache.set(result, result);
		}
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

function parseBranchStatus(
	branchLine: string | undefined,
): Pick<GitWorkingTreeStatus, "branch" | "upstream" | "ahead" | "behind"> {
	const result = {
		branch: undefined as string | undefined,
		upstream: undefined as string | undefined,
		ahead: 0,
		behind: 0,
	};
	if (!branchLine?.startsWith("# branch.")) return result;

	if (branchLine.startsWith("# branch.head ")) {
		result.branch = branchLine.slice("# branch.head ".length);
		if (result.branch === "(detached)") result.branch = "HEAD";
	} else if (branchLine.startsWith("# branch.upstream ")) {
		result.upstream = branchLine.slice("# branch.upstream ".length);
	} else if (branchLine.startsWith("# branch.ab ")) {
		const match = branchLine.match(/\+(\d+)\s+-(\d+)/);
		if (match) {
			result.ahead = Number(match[1]) || 0;
			result.behind = Number(match[2]) || 0;
		}
	}
	return result;
}

function mapPorcelainStatus(
	indexStatus: string,
	worktreeStatus: string,
): GitStatus {
	if (indexStatus === "?" && worktreeStatus === "?") return "untracked";
	if (indexStatus === "A") return "added";
	if (indexStatus === "R" || indexStatus === "C") return "renamed";
	if (worktreeStatus === "D" || indexStatus === "D") return "deleted";
	if (indexStatus !== "." && worktreeStatus === ".") return "staged";
	return "modified";
}

function parseWorkingTreeStatus(
	output: string,
	root: string,
): GitWorkingTreeStatus {
	const files: GitWorkingTreeFile[] = [];
	let branch: string | undefined;
	let upstream: string | undefined;
	let ahead = 0;
	let behind = 0;

	const records = output.split("\0").filter(Boolean);
	for (let i = 0; i < records.length; i++) {
		const record = records[i];
		if (record.startsWith("# branch.")) {
			const parsed = parseBranchStatus(record);
			branch = parsed.branch ?? branch;
			upstream = parsed.upstream ?? upstream;
			ahead = parsed.ahead || ahead;
			behind = parsed.behind || behind;
			continue;
		}

		const kind = record[0];
		if (kind === "1" || kind === "2") {
			const match =
				kind === "1"
					? record.match(/^1 (\S+) \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/)
					: record.match(/^2 (\S+) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/);
			if (!match) continue;
			const indexStatus = match[1]?.[0] ?? ".";
			const worktreeStatus = match[1]?.[1] ?? ".";
			const rawPath = match[2] ?? "";
			let originalPath: string | undefined;
			if (kind === "2") {
				originalPath = records[++i];
			}
			const pathName = normalizeGitPath(rawPath);
			files.push({
				path: pathName,
				originalPath: originalPath ? normalizeGitPath(originalPath) : undefined,
				indexStatus,
				worktreeStatus,
				status: mapPorcelainStatus(indexStatus, worktreeStatus),
				staged: indexStatus !== ".",
				unstaged: worktreeStatus !== ".",
				untracked: false,
			});
		} else if (kind === "?") {
			const pathName = normalizeGitPath(record.slice(2));
			files.push({
				path: pathName,
				indexStatus: "?",
				worktreeStatus: "?",
				status: "untracked",
				staged: false,
				unstaged: true,
				untracked: true,
			});
		}
	}

	return {
		hasGit: true,
		root,
		branch,
		upstream,
		ahead,
		behind,
		staged: files.filter((file) => file.staged).length,
		unstaged: files.filter((file) => file.unstaged).length,
		untracked: files.filter((file) => file.untracked).length,
		files,
	};
}

export async function getWorkingTreeStatus(
	projectPath: string,
): Promise<GitWorkingTreeStatus> {
	const root = await findGitRoot(projectPath);
	if (!root) {
		return {
			hasGit: false,
			ahead: 0,
			behind: 0,
			staged: 0,
			unstaged: 0,
			untracked: 0,
			files: [],
		};
	}

	return getWorkingTreeStatusAtRoot(root);
}

async function getWorkingTreeStatusAtRoot(
	root: string,
): Promise<GitWorkingTreeStatus> {
	const output = await execGit(
		["status", "--porcelain=v2", "--branch", "-z", "-uall"],
		root,
	);
	return parseWorkingTreeStatus(output, root);
}

async function showHeadBlob(root: string, relPath: string): Promise<Buffer> {
	try {
		const { stdout } = await execFileAsync("git", ["show", `HEAD:${relPath}`], {
			cwd: root,
			encoding: "buffer",
			maxBuffer: MAX_DIFF_FILE_BYTES,
		});
		return stdout;
	} catch {
		return Buffer.alloc(0);
	}
}

export async function getWorkingTreeFileDiff(
	projectPath: string,
	filePath: string,
): Promise<GitWorkingTreeFileDiff | null> {
	const root = await findGitRoot(projectPath);
	if (!root) return null;

	return getWorkingTreeFileDiffAtRoot(root, filePath);
}

async function getWorkingTreeFileDiffAtRoot(
	root: string,
	filePath: string,
): Promise<GitWorkingTreeFileDiff> {
	const relPath = normalizeGitPath(filePath);
	const absPath = path.join(root, relPath);
	const [oldBuf, newBuf] = await Promise.all([
		showHeadBlob(root, relPath),
		fsReadFileSafe(absPath),
	]);

	if (isBinaryBuffer(oldBuf) || isBinaryBuffer(newBuf)) {
		return { path: relPath, oldText: "", newText: "", binary: true };
	}

	return {
		path: relPath,
		oldText: oldBuf.toString("utf-8"),
		newText: newBuf.toString("utf-8"),
		binary: false,
	};
}

const BRANCH_FIELD_SEPARATOR = "\x1f";

function parseBranchRows(
	output: string,
	remote: boolean,
	currentBranch: string,
	defaultRef: string,
): GitBranch[] {
	const branches: GitBranch[] = [];
	for (const row of output.split("\n")) {
		if (!row) continue;
		const [ref, shortName, upstream = ""] = row.split(BRANCH_FIELD_SEPARATOR);
		if (
			!ref ||
			!shortName ||
			ref.endsWith("/HEAD") ||
			shortName.endsWith("/HEAD")
		) {
			continue;
		}
		const name = remote ? shortName.replace(/^[^/]+\//, "") : shortName;
		branches.push({
			name,
			ref: shortName,
			remote,
			current: !remote && shortName === currentBranch,
			default:
				ref === defaultRef ||
				(!defaultRef &&
					!remote &&
					(shortName === "main" || shortName === "master")),
			upstream: upstream || undefined,
		});
	}
	return branches;
}

function sortBranches(branches: GitBranch[]): GitBranch[] {
	const rank = (branch: GitBranch): number => {
		if (branch.default && !branch.remote) return 0;
		if (branch.name === "main" && !branch.remote) return 1;
		if (branch.name === "master" && !branch.remote) return 2;
		if (branch.current) return 3;
		if (!branch.remote) return 4;
		if (branch.default) return 5;
		return 6;
	};
	return branches.sort(
		(left, right) =>
			rank(left) - rank(right) ||
			left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
	);
}

async function getBranches(root: string): Promise<GitBranch[]> {
	const format = ["%(refname)", "%(refname:short)", "%(upstream:short)"].join(
		BRANCH_FIELD_SEPARATOR,
	);
	const [localOutput, remoteOutput, currentBranch, defaultRef] =
		await Promise.all([
			execGit(["for-each-ref", `--format=${format}`, "refs/heads"], root),
			execGit(["for-each-ref", `--format=${format}`, "refs/remotes"], root),
			execGit(["branch", "--show-current"], root),
			execGit(["symbolic-ref", "refs/remotes/origin/HEAD"], root).catch(
				() => "",
			),
		]);
	return sortBranches([
		...parseBranchRows(
			localOutput,
			false,
			currentBranch,
			defaultRef.replace(/^refs\/remotes\/[^/]+\//, "refs/heads/"),
		),
		...parseBranchRows(remoteOutput, true, currentBranch, defaultRef),
	]);
}

async function validateBranchName(root: string, branch: string): Promise<void> {
	if (!branch || branch.includes("\0"))
		throw new Error("Branch name is required");
	try {
		await execGit(["check-ref-format", "--branch", branch], root);
	} catch {
		throw new Error(`Invalid branch name: ${branch}`);
	}
}

async function pushCurrentBranch(root: string): Promise<string> {
	const branch = await execGit(["branch", "--show-current"], root);
	if (!branch) throw new Error("Cannot push a detached HEAD");
	const upstream = await execGit(
		["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
		root,
	).catch(() => "");
	if (upstream) return execGitWithOutput(["push"], root);

	const remotes = (await execGit(["remote"], root))
		.split("\n")
		.map((remote) => remote.trim())
		.filter(Boolean);
	const remote = remotes.includes("origin") ? "origin" : remotes[0];
	if (!remote) throw new Error("No Git remote is configured");
	return execGitWithOutput(["push", "--set-upstream", remote, branch], root);
}

async function fsReadFileSafe(filePath: string): Promise<Buffer> {
	try {
		const fs = await import("node:fs/promises");
		return await fs.readFile(filePath);
	} catch {
		return Buffer.alloc(0);
	}
}

function normalizeOperationFiles(files?: string[]): string[] {
	return (files ?? [])
		.map((file) => normalizeGitPath(file))
		.filter((file) => file && !path.isAbsolute(file) && !file.includes("\0"));
}

export async function runGitOperation(
	projectPath: string,
	operation: GitOperation,
	options: {
		files?: string[];
		file?: string;
		message?: string;
		branch?: string;
		force?: boolean;
	} = {},
): Promise<{
	ok: boolean;
	output?: string;
	status?: GitWorkingTreeStatus;
	branches?: GitBranch[];
	diff?: GitWorkingTreeFileDiff;
}> {
	const root = await findGitRoot(projectPath);
	if (!root) throw new Error("Not in a git repository");

	if (operation === "status") {
		return { ok: true, status: await getWorkingTreeStatusAtRoot(root) };
	}

	if (operation === "diff") {
		if (!options.file) throw new Error("No file selected");
		const diff = await getWorkingTreeFileDiffAtRoot(root, options.file);
		return { ok: true, diff };
	}

	if (operation === "branches") {
		return { ok: true, branches: await getBranches(root) };
	}

	const files = normalizeOperationFiles(options.files);
	let output = "";
	switch (operation) {
		case "stage":
			if (!files.length) throw new Error("No files selected");
			output = await execGitWithOutput(["add", "--", ...files], root);
			break;
		case "unstage":
			if (!files.length) throw new Error("No files selected");
			output = await execGitWithOutput(
				["restore", "--staged", "--", ...files],
				root,
			);
			break;
		case "discard": {
			if (!files.length) throw new Error("No files selected");
			const statuses = await getFileGitStatuses(root, ".");
			const tracked: string[] = [];
			const untracked: string[] = [];
			for (const file of files) {
				const status = statuses.get(file);
				if (status === "untracked" || status === "ignored") {
					untracked.push(file);
				} else {
					tracked.push(file);
				}
			}
			const outputs: string[] = [];
			if (tracked.length > 0) {
				const out = await execGitWithOutput(
					["restore", "--", ...tracked],
					root,
				);
				if (out) outputs.push(out);
			}
			if (untracked.length > 0) {
				const out = await execGitWithOutput(
					["clean", "-df", "--", ...untracked],
					root,
				);
				if (out) outputs.push(out);
			}
			output = outputs.join("\n");
			break;
		}
		case "checkout": {
			const branch = options.branch || options.message;
			if (!branch) throw new Error("Branch name is required");
			const exactLocalExists = await execGit(
				["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
				root,
			)
				.then(() => true)
				.catch(() => false);
			if (exactLocalExists) {
				output = await execGitWithOutput(["switch", branch], root);
				break;
			}
			const localName = branch.replace(/^[^/]+\//, "");
			const trackedLocalExists = await execGit(
				["show-ref", "--verify", "--quiet", `refs/heads/${localName}`],
				root,
			)
				.then(() => true)
				.catch(() => false);
			output = trackedLocalExists
				? await execGitWithOutput(["switch", localName], root)
				: await execGitWithOutput(["switch", "--track", branch], root);
			break;
		}
		case "branch-create": {
			const branch = options.branch || options.message;
			if (!branch) throw new Error("Branch name is required");
			await validateBranchName(root, branch);
			output = await execGitWithOutput(["switch", "-c", branch], root);
			break;
		}
		case "branch-delete": {
			const branch = options.branch || options.message;
			if (!branch) throw new Error("Branch name is required");
			output = await execGitWithOutput(
				["branch", options.force ? "-D" : "-d", branch],
				root,
			);
			break;
		}
		case "commit": {
			const message = options.message?.trim();
			if (!message) throw new Error("Commit message is required");
			output = await execGitWithOutput(["commit", "-m", message], root);
			break;
		}
		case "fetch":
			output = await execGitWithOutput(["fetch", "--prune"], root);
			break;
		case "pull":
			output = await execGitWithOutput(["pull", "--ff-only"], root);
			break;
		case "push":
			output = await pushCurrentBranch(root);
			break;
		default:
			throw new Error(`Unsupported git operation: ${operation}`);
	}

	return {
		ok: true,
		output,
		status: await getWorkingTreeStatusAtRoot(root),
	};
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

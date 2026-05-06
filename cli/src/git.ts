import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type { GitStatus } from "@shellular/protocol";

const execFileAsync = promisify(execFile);

function normalizeGitPath(filePath: string): string {
	return filePath.split("/").join(path.sep);
}

async function execGit(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd });
	return stdout.trim();
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
				`${targetPathSpec}${path.sep}`,
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
	const relPath = path.normalize(path.relative(repoRoot, entryAbsPath));

	if (entryType === "file") {
		return statuses.get(relPath) ?? null;
	}

	// For directories: collect statuses of all files under this prefix
	const prefix = relPath + path.sep;
	const found = new Set<GitStatus>();
	for (const [filePath, status] of statuses) {
		if (filePath.startsWith(prefix) || filePath === relPath) {
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

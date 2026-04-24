import * as fs from "node:fs";
import * as path from "node:path";

import type { Connection } from "./connection";
import {
	computeEntryGitStatus,
	findGitRoot,
	getFileGitStatuses,
	getProjectGitInfo,
} from "./git";
import {
	type FsListMsg,
	type FsListResultMsg,
	type FsMkdirMsg,
	type FsReadMsg,
	type FsReadResultMsg,
	type FsRenameMsg,
	type FsResultMsg,
	type FsStatMsg,
	type FsStatResultMsg,
	type FsWriteMsg,
	type FsWriteResultMsg,
	type GitReadMsg,
	type GitReadResultMsg,
	MsgType,
	type ProjectInfoMsg,
	type ProjectInfoResultMsg,
} from "@shellular/protocol";

/**
 * Resolve a path relative to rootDir and verify it doesn't escape.
 * Returns null if path traversal is detected.
 */
function safePath(rootDir: string, requestedPath: string): string | null {
	const resolved = path.resolve(rootDir, requestedPath);
	if (!resolved.startsWith(rootDir + path.sep) && resolved !== rootDir) {
		return null;
	}
	return resolved;
}

function findNearestExistingDir(targetPath: string): string | null {
	let current = targetPath;
	while (true) {
		if (fs.existsSync(current)) {
			try {
				return fs.statSync(current).isDirectory()
					? current
					: path.dirname(current);
			} catch {
				return null;
			}
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function initFilesystemHandler(conn: Connection, rootDir: string) {
	conn.on(MsgType.FS_LIST, async (msg: FsListMsg) => {
		const { clientId } = msg;
		const dirPath = safePath(rootDir, msg.data.path);
		if (!dirPath) {
			const respMsg: FsListResultMsg = {
				type: MsgType.FS_LIST_RESULT,
				clientId,
				respTo: msg.id,
				error: "Access denied: path outside workspace",
			};
			conn.send(respMsg);
			return;
		}

		try {
			const entries = fs.readdirSync(dirPath, { withFileTypes: true });
			const result: NonNullable<FsListResultMsg["data"]>["entries"] = entries
				.filter((e) => !e.name.startsWith("."))
				.map((entry) => {
					const fullPath = path.join(dirPath, entry.name);
					let size = 0;
					let modified = 0;
					try {
						const stat = fs.statSync(fullPath);
						size = stat.size;
						modified = stat.mtimeMs;
					} catch {}
					return {
						name: entry.name,
						type: entry.isDirectory()
							? ("directory" as const)
							: ("file" as const),
						size,
						modified,
					};
				})
				.sort((a, b) => {
					if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
					return a.name.localeCompare(b.name);
				});

			// Annotate entries with git status if inside a git repo
			const repoRoot = await findGitRoot(dirPath);
			if (repoRoot) {
				const statuses = await getFileGitStatuses(repoRoot, dirPath);
				for (const entry of result) {
					const gitStatus = computeEntryGitStatus(
						statuses,
						repoRoot,
						path.join(dirPath, entry.name),
						entry.type,
					);
					if (gitStatus) {
						entry.gitStatus = gitStatus;
					}
				}
			}

			const respMsg: FsListResultMsg = {
				type: MsgType.FS_LIST_RESULT,
				clientId,
				respTo: msg.id,
				data: { path: msg.data.path, entries: result },
			};
			conn.send(respMsg);
		} catch (err) {
			const respMsg: FsListResultMsg = {
				type: MsgType.FS_LIST_RESULT,
				clientId,
				respTo: msg.id,
				error: (err as Error).message,
			};
			conn.send(respMsg);
		}
	});

	conn.on(MsgType.FS_READ, (msg: FsReadMsg) => {
		const { clientId } = msg;
		const filePath = safePath(rootDir, msg.data.path);
		if (!filePath) {
			const respMsg: FsReadResultMsg = {
				type: MsgType.FS_READ_RESULT,
				clientId,
				respTo: msg.id,
				error: "Access denied: path outside workspace",
			};
			conn.send(respMsg);
			return;
		}

		try {
			const stat = fs.statSync(filePath);
			if (stat.size > 2 * 1024 * 1024) {
				const respMsg: FsReadResultMsg = {
					type: MsgType.FS_READ_RESULT,
					clientId,
					respTo: msg.id,
					error: "File too large (>2MB)",
				};
				conn.send(respMsg);
				return;
			}

			const buffer = fs.readFileSync(filePath);
			const isBinary = buffer.includes(0);

			const respMsg: FsReadResultMsg = {
				type: MsgType.FS_READ_RESULT,
				clientId,
				respTo: msg.id,
				data: {
					path: msg.data.path,
					content: isBinary
						? buffer.toString("base64")
						: buffer.toString("utf-8"),
					encoding: isBinary ? "base64" : "utf-8",
				},
			};
			conn.send(respMsg);
		} catch (err) {
			const respMsg: FsReadResultMsg = {
				type: MsgType.FS_READ_RESULT,
				clientId,
				respTo: msg.id,
				error: (err as Error).message,
			};
			conn.send(respMsg);
		}
	});

	conn.on(MsgType.FS_WRITE, (msg: FsWriteMsg) => {
		const { clientId } = msg;
		const filePath = safePath(rootDir, msg.data.path);
		if (!filePath) {
			const respMsg: FsWriteResultMsg = {
				type: MsgType.FS_WRITE_RESULT,
				clientId,
				respTo: msg.id,
				error: "Access denied: path outside workspace",
			};
			conn.send(respMsg);
			return;
		}

		try {
			const encoding = msg.data.encoding === "base64" ? "base64" : "utf-8";
			fs.writeFileSync(filePath, msg.data.content, { encoding });
			const respMsg: FsWriteResultMsg = {
				type: MsgType.FS_WRITE_RESULT,
				clientId,
				respTo: msg.id,
				data: { path: msg.data.path, ok: true },
			};
			conn.send(respMsg);
		} catch (err) {
			const respMsg: FsWriteResultMsg = {
				type: MsgType.FS_WRITE_RESULT,
				clientId,
				respTo: msg.id,
				error: (err as Error).message,
			};
			conn.send(respMsg);
		}
	});

	conn.on(MsgType.FS_MKDIR, (msg: FsMkdirMsg) => {
		const { clientId } = msg;
		const dirPath = safePath(rootDir, msg.data.path);
		if (!dirPath) {
			const respMsg: FsResultMsg = {
				type: MsgType.FS_RESULT,
				clientId,
				respTo: msg.id,
				error: "Access denied: path outside workspace",
			};
			conn.send(respMsg);
			return;
		}

		try {
			fs.mkdirSync(dirPath, { recursive: true });
			const respMsg: FsResultMsg = {
				type: MsgType.FS_RESULT,
				clientId,
				respTo: msg.id,
				data: { ok: true },
			};
			conn.send(respMsg);
		} catch (err) {
			const respMsg: FsResultMsg = {
				type: MsgType.FS_RESULT,
				clientId,
				respTo: msg.id,
				error: (err as Error).message,
			};
			conn.send(respMsg);
		}
	});

	conn.on(MsgType.FS_DELETE, (msg) => {
		const { clientId } = msg;
		const filePath = safePath(rootDir, msg.data.path);
		if (!filePath) {
			const respMsg: FsResultMsg = {
				type: MsgType.FS_RESULT,
				clientId,
				respTo: msg.id,
				error: "Access denied: path outside workspace",
			};
			conn.send(respMsg);
			return;
		}

		if (filePath === rootDir) {
			const respMsg: FsResultMsg = {
				type: MsgType.FS_RESULT,
				clientId,
				respTo: msg.id,
				error: "Cannot delete workspace root",
			};
			conn.send(respMsg);
			return;
		}

		try {
			fs.rmSync(filePath, { recursive: true });
			const respMsg: FsResultMsg = {
				type: MsgType.FS_RESULT,
				clientId,
				respTo: msg.id,
				data: { ok: true },
			};
			conn.send(respMsg);
		} catch (err) {
			const respMsg: FsResultMsg = {
				type: MsgType.FS_RESULT,
				clientId,
				respTo: msg.id,
				error: (err as Error).message,
			};
			conn.send(respMsg);
		}
	});

	conn.on(MsgType.FS_RENAME, (msg: FsRenameMsg) => {
		const { clientId } = msg;
		const oldPath = safePath(rootDir, msg.data.oldPath);
		const newPath = safePath(rootDir, msg.data.newPath);
		if (!oldPath || !newPath) {
			const respMsg: FsResultMsg = {
				type: MsgType.FS_RESULT,
				clientId,
				respTo: msg.id,
				error: "Access denied: path outside workspace",
			};
			conn.send(respMsg);
			return;
		}

		try {
			fs.renameSync(oldPath, newPath);
			const respMsg: FsResultMsg = {
				type: MsgType.FS_RESULT,
				clientId,
				respTo: msg.id,
				data: { ok: true },
			};
			conn.send(respMsg);
		} catch (err) {
			const respMsg: FsResultMsg = {
				type: MsgType.FS_RESULT,
				clientId,
				respTo: msg.id,
				error: (err as Error).message,
			};
			conn.send(respMsg);
		}
	});

	conn.on(MsgType.FS_STAT, (msg: FsStatMsg) => {
		const { clientId } = msg;
		const filePath = safePath(rootDir, msg.data.path);
		if (!filePath) {
			const respMsg: FsStatResultMsg = {
				type: MsgType.FS_STAT_RESULT,
				clientId,
				respTo: msg.id,
				error: "Access denied: path outside workspace",
			};
			conn.send(respMsg);
			return;
		}

		try {
			const stat = fs.statSync(filePath);
			const respMsg: FsStatResultMsg = {
				type: MsgType.FS_STAT_RESULT,
				clientId,
				respTo: msg.id,
				data: {
					path: msg.data.path,
					name: path.basename(filePath),
					type: stat.isDirectory() ? "directory" : "file",
					size: stat.size,
					modified: stat.mtimeMs,
				},
			};
			conn.send(respMsg);
		} catch (err) {
			const respMsg: FsStatResultMsg = {
				type: MsgType.FS_STAT_RESULT,
				clientId,
				respTo: msg.id,
				error: (err as Error).message,
			};
			conn.send(respMsg);
		}
	});

	conn.on(MsgType.PROJECT_INFO, async (msg: ProjectInfoMsg) => {
		const { clientId } = msg;
		let isValidProjectPath = false;
		try {
			isValidProjectPath =
				fs.existsSync(msg.data.path) &&
				fs.statSync(msg.data.path).isDirectory();
		} catch {
			isValidProjectPath = false;
		}

		if (!isValidProjectPath) {
			const respMsg: ProjectInfoResultMsg = {
				type: MsgType.PROJECT_INFO_RESULT,
				clientId,
				respTo: msg.id,
				error: "path not found",
			};
			conn.send(respMsg);
			return;
		}

		try {
			const info = await getProjectGitInfo(msg.data.path);
			const respMsg: ProjectInfoResultMsg = {
				type: MsgType.PROJECT_INFO_RESULT,
				clientId,
				respTo: msg.id,
				data: info,
			};
			conn.send(respMsg);
		} catch (err) {
			const respMsg: ProjectInfoResultMsg = {
				type: MsgType.PROJECT_INFO_RESULT,
				clientId,
				respTo: msg.id,
				error: (err as Error).message,
			};
			conn.send(respMsg);
		}
	});

	conn.on(MsgType.GIT_READ, async (msg: GitReadMsg) => {
		const { clientId } = msg;
		const filePath = safePath(rootDir, msg.data.path);
		if (!filePath) {
			const respMsg: GitReadResultMsg = {
				type: MsgType.GIT_READ_RESULT,
				clientId,
				respTo: msg.id,
				error: "Access denied: path outside workspace",
			};
			conn.send(respMsg);
			return;
		}

		try {
			// For new/deleted files, resolve git root from nearest existing parent.
			const probeDir = findNearestExistingDir(filePath);
			if (!probeDir) {
				const respMsg: GitReadResultMsg = {
					type: MsgType.GIT_READ_RESULT,
					clientId,
					respTo: msg.id,
					error: "Path not found",
				};
				conn.send(respMsg);
				return;
			}

			// Get the git root directory
			const gitRoot = await findGitRoot(probeDir);
			if (!gitRoot) {
				const respMsg: GitReadResultMsg = {
					type: MsgType.GIT_READ_RESULT,
					clientId,
					respTo: msg.id,
					error: "Not in a git repository",
				};
				conn.send(respMsg);
				return;
			}

			// Get relative path from git root
			const relPath = path.relative(gitRoot, filePath);

			// Read original file content from git HEAD
			const { execSync } = await import("node:child_process");
			let content: string;
			try {
				// Use git show HEAD:<relative-path> to get original content
				content = execSync(`git show HEAD:"${relPath}"`, {
					cwd: gitRoot,
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "pipe"], // silence stderr
				});
			} catch {
				// File might not exist in HEAD (new file), return empty
				content = "";
			}

			// Determine encoding
			const isBinary = content.includes("\0");
			const encoding: "base64" | "utf-8" = isBinary ? "base64" : "utf-8";
			const encoded = isBinary
				? Buffer.from(content).toString("base64")
				: content;

			const respMsg: GitReadResultMsg = {
				type: MsgType.GIT_READ_RESULT,
				clientId,
				respTo: msg.id,
				data: {
					path: filePath,
					content: encoded,
					encoding,
				},
			};
			conn.send(respMsg);
		} catch (err) {
			const respMsg: GitReadResultMsg = {
				type: MsgType.GIT_READ_RESULT,
				clientId,
				respTo: msg.id,
				error: (err as Error).message,
			};
			conn.send(respMsg);
		}
	});
}

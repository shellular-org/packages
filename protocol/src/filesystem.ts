import { z } from "zod";

import { MsgType } from "./base";

// ─── Shared ───────────────────────────────────────────────────────────────────

export const GitStatusSchema = z.enum([
	"modified",
	"staged",
	"added",
	"deleted",
	"renamed",
	"untracked",
	"ignored",
]);
export type GitStatus = z.infer<typeof GitStatusSchema>;

export const GitCommitSchema = z.object({
	hash: z.string(),
	shortHash: z.string(),
	author: z.string(),
	email: z.string(),
	/** Commit time as a unix timestamp in seconds. */
	timestamp: z.number(),
	subject: z.string(),
});
export type GitCommit = z.infer<typeof GitCommitSchema>;

export const GitCommitFileSchema = z.object({
	path: z.string(),
	status: GitStatusSchema,
});
export type GitCommitFile = z.infer<typeof GitCommitFileSchema>;

export const GitWorkingTreeFileSchema = z.object({
	path: z.string(),
	originalPath: z.string().optional(),
	indexStatus: z.string(),
	worktreeStatus: z.string(),
	status: GitStatusSchema,
	staged: z.boolean(),
	unstaged: z.boolean(),
	untracked: z.boolean(),
});
export type GitWorkingTreeFile = z.infer<typeof GitWorkingTreeFileSchema>;

export const GitWorkingTreeStatusSchema = z.object({
	hasGit: z.boolean(),
	root: z.string().optional(),
	branch: z.string().optional(),
	upstream: z.string().optional(),
	ahead: z.number(),
	behind: z.number(),
	staged: z.number(),
	unstaged: z.number(),
	untracked: z.number(),
	files: z.array(GitWorkingTreeFileSchema),
});
export type GitWorkingTreeStatus = z.infer<typeof GitWorkingTreeStatusSchema>;

export const GitBranchSchema = z.object({
	name: z.string(),
	ref: z.string(),
	remote: z.boolean(),
	current: z.boolean(),
	default: z.boolean(),
	upstream: z.string().optional(),
});
export type GitBranch = z.infer<typeof GitBranchSchema>;

export const GitWorkingTreeFileDiffSchema = z.object({
	path: z.string(),
	oldText: z.string(),
	newText: z.string(),
	binary: z.boolean(),
});
export type GitWorkingTreeFileDiff = z.infer<
	typeof GitWorkingTreeFileDiffSchema
>;

export const GitOperationSchema = z.enum([
	"status",
	"diff",
	"stage",
	"unstage",
	"discard",
	"commit",
	"fetch",
	"pull",
	"push",
	"branches",
	"checkout",
	"branch-create",
	"branch-delete",
]);
export type GitOperation = z.infer<typeof GitOperationSchema>;

// ─── Incoming (client → CLI) ──────────────────────────────────────────────────

export const FsListMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.FS_LIST),
	clientId: z.string(),
	data: z.object({
		path: z.string(),
		showHidden: z.boolean().optional(),
	}),
});
export type FsListMsg = z.infer<typeof FsListMsgSchema>;

export const FsReadMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.FS_READ),
	clientId: z.string(),
	data: z.object({
		path: z.string(),
	}),
});
export type FsReadMsg = z.infer<typeof FsReadMsgSchema>;

export const FsWriteMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.FS_WRITE),
	clientId: z.string(),
	data: z.object({
		path: z.string(),
		content: z.string(),
		encoding: z.string().optional(),
	}),
});
export type FsWriteMsg = z.infer<typeof FsWriteMsgSchema>;

export const FsMkdirMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.FS_MKDIR),
	clientId: z.string(),
	data: z.object({
		path: z.string(),
	}),
});
export type FsMkdirMsg = z.infer<typeof FsMkdirMsgSchema>;

export const FsDeleteMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.FS_DELETE),
	clientId: z.string(),
	data: z.object({
		path: z.string(),
	}),
});
export type FsDeleteMsg = z.infer<typeof FsDeleteMsgSchema>;

export const FsRenameMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.FS_RENAME),
	clientId: z.string(),
	data: z.object({
		oldPath: z.string(),
		newPath: z.string(),
	}),
});
export type FsRenameMsg = z.infer<typeof FsRenameMsgSchema>;

export const FsStatMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.FS_STAT),
	clientId: z.string(),
	data: z.object({
		path: z.string(),
	}),
});
export type FsStatMsg = z.infer<typeof FsStatMsgSchema>;

export const GitReadMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.GIT_READ),
	clientId: z.string(),
	data: z.object({
		path: z.string(),
	}),
});
export type GitReadMsg = z.infer<typeof GitReadMsgSchema>;

export const GitLogMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.GIT_LOG),
	clientId: z.string(),
	data: z.object({
		path: z.string(),
		skip: z.number().optional(),
		limit: z.number().optional(),
	}),
});
export type GitLogMsg = z.infer<typeof GitLogMsgSchema>;

export const GitCommitFilesMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.GIT_COMMIT_FILES),
	clientId: z.string(),
	data: z.object({
		path: z.string(),
		hash: z.string(),
	}),
});
export type GitCommitFilesMsg = z.infer<typeof GitCommitFilesMsgSchema>;

export const GitCommitFileDiffMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.GIT_COMMIT_FILE_DIFF),
	clientId: z.string(),
	data: z.object({
		path: z.string(),
		hash: z.string(),
		file: z.string(),
	}),
});
export type GitCommitFileDiffMsg = z.infer<typeof GitCommitFileDiffMsgSchema>;

export const GitOperationMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.GIT_OPERATION),
	clientId: z.string(),
	data: z.object({
		path: z.string(),
		operation: GitOperationSchema,
		files: z.array(z.string()).optional(),
		file: z.string().optional(),
		message: z.string().optional(),
		branch: z.string().optional(),
		force: z.boolean().optional(),
	}),
});
export type GitOperationMsg = z.infer<typeof GitOperationMsgSchema>;

export const ProjectInfoMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.GIT_OPERATION),
	clientId: z.string(),
	data: z.object({
		path: z.string(),
		operation: GitOperationSchema,
		files: z.array(z.string()).optional(),
		file: z.string().optional(),
		message: z.string().optional(),
		branch: z.string().optional(),
		force: z.boolean().optional(),
	}),
});
export type GitOperationMsg = z.infer<typeof GitOperationMsgSchema>;

export const ProjectInfoMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.PROJECT_INFO),
	clientId: z.string(),
	data: z.object({
		path: z.string(),
	}),
});
export type ProjectInfoMsg = z.infer<typeof ProjectInfoMsgSchema>;

// ─── Outgoing (CLI → client) ──────────────────────────────────────────────────

export const FsResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.FS_RESULT),
	clientId: z.string(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			ok: z.boolean().optional(),
		})
		.optional(),
});
export type FsResultMsg = z.infer<typeof FsResultMsgSchema>;

export const FsListResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.FS_LIST_RESULT),
	clientId: z.string(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			path: z.string().optional(),
			entries: z
				.array(
					z.object({
						name: z.string(),
						type: z.enum(["directory", "file"]),
						size: z.number(),
						modified: z.number(),
						gitStatus: GitStatusSchema.nullable().optional(),
					}),
				)
				.optional(),
		})
		.optional(),
});
export type FsListResultMsg = z.infer<typeof FsListResultMsgSchema>;

export const FsReadResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.FS_READ_RESULT),
	clientId: z.string(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			path: z.string().optional(),
			content: z.string().optional(),
			encoding: z.enum(["base64", "utf-8"]).optional(),
		})
		.optional(),
});
export type FsReadResultMsg = z.infer<typeof FsReadResultMsgSchema>;

export const FsWriteResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.FS_WRITE_RESULT),
	clientId: z.string(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			path: z.string().optional(),
			ok: z.boolean().optional(),
		})
		.optional(),
});
export type FsWriteResultMsg = z.infer<typeof FsWriteResultMsgSchema>;

export const FsStatResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.FS_STAT_RESULT),
	clientId: z.string(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			path: z.string().optional(),
			name: z.string().optional(),
			type: z.enum(["directory", "file"]).optional(),
			size: z.number().optional(),
			modified: z.number().optional(),
		})
		.optional(),
});
export type FsStatResultMsg = z.infer<typeof FsStatResultMsgSchema>;

export const GitReadResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.GIT_READ_RESULT),
	clientId: z.string(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			path: z.string().optional(),
			content: z.string().optional(),
			encoding: z.enum(["base64", "utf-8"]).optional(),
		})
		.optional(),
});
export type GitReadResultMsg = z.infer<typeof GitReadResultMsgSchema>;

export const GitLogResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.GIT_LOG_RESULT),
	clientId: z.string(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			commits: z.array(GitCommitSchema),
			hasMore: z.boolean(),
			total: z.number(),
		})
		.optional(),
});
export type GitLogResultMsg = z.infer<typeof GitLogResultMsgSchema>;

export const GitCommitFilesResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.GIT_COMMIT_FILES_RESULT),
	clientId: z.string(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			files: z.array(GitCommitFileSchema),
		})
		.optional(),
});
export type GitCommitFilesResultMsg = z.infer<
	typeof GitCommitFilesResultMsgSchema
>;

export const GitCommitFileDiffResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.GIT_COMMIT_FILE_DIFF_RESULT),
	clientId: z.string(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			oldText: z.string(),
			newText: z.string(),
			binary: z.boolean(),
		})
		.optional(),
});
export type GitCommitFileDiffResultMsg = z.infer<
	typeof GitCommitFileDiffResultMsgSchema
>;

export const GitOperationResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.GIT_OPERATION_RESULT),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			ok: z.boolean(),
			output: z.string().optional(),
			status: GitWorkingTreeStatusSchema.optional(),
			branches: z.array(GitBranchSchema).optional(),
			diff: GitWorkingTreeFileDiffSchema.optional(),
		})
		.optional(),
});
export type GitOperationResultMsg = z.infer<typeof GitOperationResultMsgSchema>;

export const ProjectInfoResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.PROJECT_INFO_RESULT),
	clientId: z.string(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.discriminatedUnion("hasGit", [
			z.object({ hasGit: z.literal(false) }),
			z.object({
				hasGit: z.literal(true),
				branch: z.string(),
				ahead: z.number(),
				behind: z.number(),
				staged: z.number(),
				unstaged: z.number(),
				untracked: z.number(),
			}),
		])
		.optional(),
});
export type ProjectInfoResultMsg = z.infer<typeof ProjectInfoResultMsgSchema>;

export const ProjectFileSearchMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.PROJECT_FILE_SEARCH),
	clientId: z.string(),
	data: z.object({
		path: z.string(),
		query: z.string(),
		limit: z.number().optional(),
		selectedPath: z.string().optional(),
		includeHistory: z.boolean().optional(),
		refresh: z.boolean().optional(),
	}),
});
export type ProjectFileSearchMsg = z.infer<typeof ProjectFileSearchMsgSchema>;

export const ProjectFileSearchResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.PROJECT_FILE_SEARCH_RESULT),
	clientId: z.string(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			path: z.string(),
			query: z.string(),
			entries: z.array(
				z.object({
					name: z.string(),
					path: z.string(),
					relativePath: z.string(),
					type: z.enum(["directory", "file"]),
					size: z.number(),
					modified: z.number(),
					gitStatus: GitStatusSchema.nullable().optional(),
					score: z
						.object({
							total: z.number(),
							matchType: z.string(),
							exactMatch: z.boolean(),
							filenameBonus: z.number(),
							frecencyBoost: z.number(),
							comboMatchBoost: z.number(),
						})
						.optional(),
				}),
			),
			history: z.array(z.string()),
			status: z.object({
				isScanning: z.boolean(),
				scannedFilesCount: z.number(),
				indexedFiles: z.number().optional(),
				diagnostics: z
					.object({
						nativeAvailable: z.boolean(),
						gitAvailable: z.boolean().optional(),
						repositoryFound: z.boolean().optional(),
						issues: z.array(z.string()),
					})
					.optional(),
			}),
		})
		.optional(),
});
export type ProjectFileSearchResultMsg = z.infer<
	typeof ProjectFileSearchResultMsgSchema
>;

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

// ─── Incoming (client → CLI) ──────────────────────────────────────────────────

export const FsListMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.FS_LIST),
	clientId: z.string(),
	data: z.object({
		path: z.string(),
	}),
});
export type FsListMsg = z.infer<typeof FsListMsgSchema>;

export const FsReadMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.FS_READ),
	clientId: z.string(),
	data: z.object({
		path: z.string(),
	}),
});
export type FsReadMsg = z.infer<typeof FsReadMsgSchema>;

export const FsWriteMsgSchema = z.object({
	id: z.string().optional(),
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
	id: z.string().optional(),
	type: z.literal(MsgType.FS_MKDIR),
	clientId: z.string(),
	data: z.object({
		path: z.string(),
	}),
});
export type FsMkdirMsg = z.infer<typeof FsMkdirMsgSchema>;

export const FsDeleteMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.FS_DELETE),
	clientId: z.string(),
	data: z.object({
		path: z.string(),
	}),
});
export type FsDeleteMsg = z.infer<typeof FsDeleteMsgSchema>;

export const FsRenameMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.FS_RENAME),
	clientId: z.string(),
	data: z.object({
		oldPath: z.string(),
		newPath: z.string(),
	}),
});
export type FsRenameMsg = z.infer<typeof FsRenameMsgSchema>;

export const FsStatMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.FS_STAT),
	clientId: z.string(),
	data: z.object({
		path: z.string(),
	}),
});
export type FsStatMsg = z.infer<typeof FsStatMsgSchema>;

export const GitReadMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.GIT_READ),
	clientId: z.string(),
	data: z.object({
		path: z.string(),
	}),
});
export type GitReadMsg = z.infer<typeof GitReadMsgSchema>;

export const ProjectInfoMsgSchema = z.object({
	id: z.string().optional(),
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
	clientId: z.string().optional(),
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
	clientId: z.string().optional(),
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
	clientId: z.string().optional(),
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
	clientId: z.string().optional(),
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
	clientId: z.string().optional(),
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
	clientId: z.string().optional(),
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

export const ProjectInfoResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.PROJECT_INFO_RESULT),
	clientId: z.string().optional(),
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

export * from "./acp";

// ─── Agent Info (Shellular-specific, not in the ACP spec) ─────────────────────

export const AcpAgentConnectionStates = [
	"unavailable",
	"starting",
	"ready",
	"failed",
	"exited",
] as const;
export type AcpAgentConnectionState = (typeof AcpAgentConnectionStates)[number];

// ─── Shellular wire protocol schemas for ACP operations ───────────────────────
// These define the app ↔ CLI websocket message shapes that bridge ACP concepts
// into the existing Shellular protocol. They were separated from ai.ts to keep
// the old AI system's types isolated from the new ACP integration.

import {
	zAvailableCommand as AcpAvailableCommandSchema,
	zContentBlock as AcpContentBlockSchema,
} from "@agentclientprotocol/sdk/dist/schema/zod.gen.js";
import { z } from "zod";
import {
	AiBackendSchema,
	AiMessagePartSchema,
	AiMessageSchema,
	AiSessionRuntimeStateSchema,
	AiSessionSchema,
} from "@/ai-legacy";
import { MsgType } from "@/base";

export { AcpAvailableCommandSchema, AcpContentBlockSchema };

// ── ACP Session Config (loose, passes unknown metadata through) ──────────────

export const AiSessionConfigSelectOptionSchema = z
	.object({
		value: z.string(),
		name: z.string(),
		description: z.string().nullable().optional(),
	})
	.catchall(z.unknown());

export const AiSessionConfigSelectGroupSchema = z
	.object({
		group: z.string(),
		name: z.string(),
		options: z.array(AiSessionConfigSelectOptionSchema),
	})
	.catchall(z.unknown());

export const AiSessionConfigOptionSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		description: z.string().nullable().optional(),
		category: z.string().nullable().optional(),
		type: z.string(),
		currentValue: z.union([z.string(), z.boolean()]),
		options: z
			.array(
				z.union([
					AiSessionConfigSelectOptionSchema,
					AiSessionConfigSelectGroupSchema,
				]),
			)
			.optional(),
	})
	.catchall(z.unknown());
export type AiSessionConfigOption = z.infer<typeof AiSessionConfigOptionSchema>;

export const AiMcpServerSchema = z.record(z.string(), z.unknown());
export type AiMcpServer = z.infer<typeof AiMcpServerSchema>;

export const AiSessionStateSchema = z.object({
	availableCommands: z.array(AcpAvailableCommandSchema).optional(),
	configOptions: z.array(AiSessionConfigOptionSchema).optional(),
	models: z.unknown().optional(),
	modes: z.unknown().optional(),
});
export type AiSessionState = z.infer<typeof AiSessionStateSchema>;

// ── ACP Content Rendering (new integration only) ────────────────────────────

const AcpRenderedContentMetadataSchema = z.object({
	name: z.string().optional(),
	title: z.string().optional(),
	description: z.string().optional(),
	mimeType: z.string().optional(),
	size: z.number().optional(),
	uri: z.string().optional(),
	rawContent: z.unknown().optional(),
});

export const AcpMessagePartAudioSchema =
	AcpRenderedContentMetadataSchema.extend({
		id: z.string().optional(),
		type: z.literal("audio"),
		src: z.string(),
		mime: z.string().optional(),
	});
export type AcpMessagePartAudio = z.infer<typeof AcpMessagePartAudioSchema>;

export const AcpMessagePartResourceSchema =
	AcpRenderedContentMetadataSchema.extend({
		id: z.string().optional(),
		type: z.literal("resource"),
		uri: z.string(),
		text: z.string().optional(),
		blob: z.string().optional(),
	});
export type AcpMessagePartResource = z.infer<
	typeof AcpMessagePartResourceSchema
>;

export const AcpMessagePartSchema = z.union([
	AiMessagePartSchema,
	AcpMessagePartAudioSchema,
	AcpMessagePartResourceSchema,
]);
export type AcpMessagePart = z.infer<typeof AcpMessagePartSchema> & {
	metadata?: unknown;
	rawContent?: unknown;
	alt?: string;
	mime?: string;
	uri?: string;
	name?: string;
	title?: string;
	description?: string;
	mimeType?: string;
	size?: number;
};

export const AcpMessageSchema = AiMessageSchema.extend({
	parts: z.array(AcpMessagePartSchema).default([]),
});
export type AcpMessage = {
	id?: string;
	role: "user" | "assistant";
	parts: AcpMessagePart[];
	timestamp?: number;
	[key: string]: unknown;
};

export const AiSessionSetupSchema = z.object({
	backend: AiBackendSchema,
	sessionId: z.string().optional(),
	cwd: z.string(),
	additionalDirectories: z.array(z.string()).optional(),
	mcpServers: z.array(AiMcpServerSchema).optional(),
});

// ── ACP Session with configOptions (extends the base AiSession) ──────────────

export const AcpAiSessionSchema = AiSessionSchema.extend({
	configOptions: z.array(z.any()).optional(),
});
export type AcpAiSession = z.infer<typeof AcpAiSessionSchema>;

// ── Incoming messages (app → CLI) ────────────────────────────────────────────

export const AiSessionLoadMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_SESSION_LOAD),
	clientId: z.string(),
	data: AiSessionSetupSchema.extend({
		sessionId: z.string(),
	}),
});
export type AiSessionLoadMsg = z.infer<typeof AiSessionLoadMsgSchema>;

export const AiSessionAttachMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_SESSION_ATTACH),
	clientId: z.string(),
	data: AiSessionSetupSchema.extend({
		sessionId: z.string(),
	}),
});
export type AiSessionAttachMsg = z.infer<typeof AiSessionAttachMsgSchema>;

export const AiSessionDetachMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_SESSION_DETACH),
	clientId: z.string(),
	data: z.object({
		backend: AiBackendSchema,
		sessionId: z.string(),
	}),
});
export type AiSessionDetachMsg = z.infer<typeof AiSessionDetachMsgSchema>;

export const AiSessionResumeMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_SESSION_RESUME),
	clientId: z.string(),
	data: AiSessionSetupSchema.extend({
		sessionId: z.string(),
	}),
});
export type AiSessionResumeMsg = z.infer<typeof AiSessionResumeMsgSchema>;

export const AiSessionForkMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_SESSION_FORK),
	clientId: z.string(),
	data: AiSessionSetupSchema.extend({
		sessionId: z.string(),
	}),
});
export type AiSessionForkMsg = z.infer<typeof AiSessionForkMsgSchema>;

export const AiSessionCloseMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_SESSION_CLOSE),
	clientId: z.string(),
	data: z.object({
		backend: AiBackendSchema,
		sessionId: z.string(),
	}),
});
export type AiSessionCloseMsg = z.infer<typeof AiSessionCloseMsgSchema>;

export const AiSessionConfigSetMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_SESSION_CONFIG_SET),
	clientId: z.string(),
	data: z.object({
		backend: AiBackendSchema,
		sessionId: z.string(),
		configId: z.string(),
		value: z.union([z.string(), z.boolean()]),
	}),
});
export type AiSessionConfigSetMsg = z.infer<typeof AiSessionConfigSetMsgSchema>;

export const AiSessionModeSetMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_SESSION_MODE_SET),
	clientId: z.string(),
	data: z.object({
		backend: AiBackendSchema,
		sessionId: z.string(),
		modeId: z.string(),
	}),
});
export type AiSessionModeSetMsg = z.infer<typeof AiSessionModeSetMsgSchema>;

export const AiSessionModelSetMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_SESSION_MODEL_SET),
	clientId: z.string(),
	data: z.object({
		backend: AiBackendSchema,
		sessionId: z.string(),
		modelId: z.string(),
	}),
});
export type AiSessionModelSetMsg = z.infer<typeof AiSessionModelSetMsgSchema>;

export const AiAttachmentWriteMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_ATTACHMENT_WRITE),
	clientId: z.string(),
	data: z.object({
		backend: AiBackendSchema,
		sessionId: z.string(),
		name: z.string(),
		content: z.string(),
		mimeType: z.string().startsWith("image/"),
		encoding: z.literal("base64"),
	}),
});
export type AiAttachmentWriteMsg = z.infer<typeof AiAttachmentWriteMsgSchema>;

// ── Result messages (CLI → app) ──────────────────────────────────────────────

export const AiSessionLoadResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_SESSION_LOAD_RESULT),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			backend: AiBackendSchema,
			session: AcpAiSessionSchema,
			state: AiSessionStateSchema.optional(),
			runtimeState: AiSessionRuntimeStateSchema.optional(),
			messages: z.array(AcpMessageSchema),
			updates: z.array(z.unknown()).optional(),
		})
		.optional(),
});
export type AiSessionLoadResultMsg = z.infer<
	typeof AiSessionLoadResultMsgSchema
>;

export const AiSessionAttachResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_SESSION_ATTACH_RESULT),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			backend: AiBackendSchema,
			session: AcpAiSessionSchema,
			state: AiSessionStateSchema.optional(),
			runtimeState: AiSessionRuntimeStateSchema.optional(),
			messages: z.array(AcpMessageSchema),
			updates: z.array(z.unknown()).optional(),
			revision: z.number().int().nonnegative(),
			syncing: z.boolean().optional(),
		})
		.optional(),
});
export type AiSessionAttachResultMsg = z.infer<
	typeof AiSessionAttachResultMsgSchema
>;

export const AiSessionDetachResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_SESSION_DETACH_RESULT),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			backend: AiBackendSchema,
			sessionId: z.string(),
			ok: z.literal(true),
		})
		.optional(),
});
export type AiSessionDetachResultMsg = z.infer<
	typeof AiSessionDetachResultMsgSchema
>;

export const AiSessionResumeResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_SESSION_RESUME_RESULT),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			backend: AiBackendSchema,
			session: AcpAiSessionSchema,
			state: AiSessionStateSchema.optional(),
			runtimeState: AiSessionRuntimeStateSchema.optional(),
		})
		.optional(),
});
export type AiSessionResumeResultMsg = z.infer<
	typeof AiSessionResumeResultMsgSchema
>;

export const AiSessionForkResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_SESSION_FORK_RESULT),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			backend: AiBackendSchema,
			session: AcpAiSessionSchema,
			state: AiSessionStateSchema.optional(),
			runtimeState: AiSessionRuntimeStateSchema.optional(),
		})
		.optional(),
});
export type AiSessionForkResultMsg = z.infer<
	typeof AiSessionForkResultMsgSchema
>;

export const AiSessionCloseResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_SESSION_CLOSE_RESULT),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			backend: AiBackendSchema,
			sessionId: z.string(),
			ok: z.literal(true),
		})
		.optional(),
});
export type AiSessionCloseResultMsg = z.infer<
	typeof AiSessionCloseResultMsgSchema
>;

export const AiSessionConfigSetResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_SESSION_CONFIG_SET_RESULT),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			backend: AiBackendSchema,
			sessionId: z.string(),
			configOptions: z.array(AiSessionConfigOptionSchema),
		})
		.optional(),
});
export type AiSessionConfigSetResultMsg = z.infer<
	typeof AiSessionConfigSetResultMsgSchema
>;

export const AiSessionModeSetResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_SESSION_MODE_SET_RESULT),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			backend: AiBackendSchema,
			sessionId: z.string(),
			modeId: z.string(),
			ok: z.literal(true),
		})
		.optional(),
});
export type AiSessionModeSetResultMsg = z.infer<
	typeof AiSessionModeSetResultMsgSchema
>;

export const AiSessionModelSetResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_SESSION_MODEL_SET_RESULT),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			backend: AiBackendSchema,
			sessionId: z.string(),
			modelId: z.string(),
			ok: z.literal(true),
		})
		.optional(),
});
export type AiSessionModelSetResultMsg = z.infer<
	typeof AiSessionModelSetResultMsgSchema
>;

export const AiAttachmentWriteResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_ATTACHMENT_WRITE_RESULT),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			backend: AiBackendSchema,
			sessionId: z.string(),
			path: z.string(),
			name: z.string(),
			size: z.number(),
			mimeType: z.string().optional(),
		})
		.optional(),
});
export type AiAttachmentWriteResultMsg = z.infer<
	typeof AiAttachmentWriteResultMsgSchema
>;

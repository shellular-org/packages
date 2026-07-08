export * from "./acp";

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

// ─── Agent Info (Shellular-specific, not in the ACP spec) ─────────────────────

export const AgentIdSchema = AiBackendSchema;
export type AgentId = z.infer<typeof AgentIdSchema>;
export const AGENT_IDS = [
	"opencode",
	"codex",
	"claude-code",
	"copilot",
	"cursor",
	"pi",
	"hermes",
	"grok-build",
];

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

export const AgentInstallCommandSchema = z.object({
	command: z.string(),
	os: z.array(z.string()),
});
export type AgentInstallCommand = z.infer<typeof AgentInstallCommandSchema>;

export const CustomAcpAgentInputSchema = z.object({
	id: z.string(),
	name: z.string(),
	title: z.string().optional(),
	description: z.string().optional(),
	icon: z.string().optional(),
	command: z.string(),
	args: z.array(z.string()).optional(),
	env: z.record(z.string(), z.string()).optional(),
	cwd: z.string().optional(),
});
export type CustomAcpAgentInput = z.infer<typeof CustomAcpAgentInputSchema>;

export const ManagedAcpAgentInfoSchema = z
	.object({
		id: AgentIdSchema,
		backend: AgentIdSchema.optional(),
		name: z.string(),
		title: z.string(),
		version: z.string().optional(),
		description: z.string().optional(),
		note: z.string().optional(),
		icon: z.string().optional(),
		source: z.enum(["builtin", "custom"]),
		state: z.enum(AcpAgentConnectionStates),
		enabled: z.boolean(),
		installed: z.boolean(),
		available: z.boolean(),
		error: z.string().optional(),
		capabilities: z.record(z.string(), z.unknown()).optional(),
		custom: CustomAcpAgentInputSchema.optional(),
		installationCommands: z
			.record(z.string(), AgentInstallCommandSchema)
			.optional(),
		adapter: z
			.object({
				command: z.string(),
				available: z.boolean(),
			})
			.optional(),
	})
	.catchall(z.unknown());
export type ManagedAcpAgentInfo = z.infer<typeof ManagedAcpAgentInfoSchema>;

export const AgentManagementResultDataSchema = z
	.object({
		ok: z.boolean(),
		agent: ManagedAcpAgentInfoSchema.optional(),
		agents: z.array(ManagedAcpAgentInfoSchema).optional(),
	})
	.catchall(z.unknown());
export type AgentManagementResultData = z.infer<
	typeof AgentManagementResultDataSchema
>;

export const AiSessionStateSchema = z.object({
	availableCommands: z.array(AcpAvailableCommandSchema).optional(),
	configOptions: z.array(AiSessionConfigOptionSchema).optional(),
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
	backend: AgentIdSchema,
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
	id: z.string(),
	type: z.literal(MsgType.AI_SESSION_LOAD),
	clientId: z.string(),
	data: AiSessionSetupSchema.extend({
		sessionId: z.string(),
	}),
});
export type AiSessionLoadMsg = z.infer<typeof AiSessionLoadMsgSchema>;

export const AiSessionAttachMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.AI_SESSION_ATTACH),
	clientId: z.string(),
	data: AiSessionSetupSchema.extend({
		sessionId: z.string(),
	}),
});
export type AiSessionAttachMsg = z.infer<typeof AiSessionAttachMsgSchema>;

export const AiSessionDetachMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.AI_SESSION_DETACH),
	clientId: z.string(),
	data: z.object({
		backend: AgentIdSchema,
		sessionId: z.string(),
	}),
});
export type AiSessionDetachMsg = z.infer<typeof AiSessionDetachMsgSchema>;

export const AiSessionResumeMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.AI_SESSION_RESUME),
	clientId: z.string(),
	data: AiSessionSetupSchema.extend({
		sessionId: z.string(),
	}),
});
export type AiSessionResumeMsg = z.infer<typeof AiSessionResumeMsgSchema>;

export const AiSessionForkMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.AI_SESSION_FORK),
	clientId: z.string(),
	data: AiSessionSetupSchema.extend({
		sessionId: z.string(),
	}),
});
export type AiSessionForkMsg = z.infer<typeof AiSessionForkMsgSchema>;

export const AiSessionCloseMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.AI_SESSION_CLOSE),
	clientId: z.string(),
	data: z.object({
		backend: AgentIdSchema,
		sessionId: z.string(),
	}),
});
export type AiSessionCloseMsg = z.infer<typeof AiSessionCloseMsgSchema>;

export const AiSessionConfigSetMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.AI_SESSION_CONFIG_SET),
	clientId: z.string(),
	data: z.object({
		backend: AgentIdSchema,
		sessionId: z.string(),
		configId: z.string(),
		value: z.union([z.string(), z.boolean()]),
	}),
});
export type AiSessionConfigSetMsg = z.infer<typeof AiSessionConfigSetMsgSchema>;

export const AiSessionModeSetMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.AI_SESSION_MODE_SET),
	clientId: z.string(),
	data: z.object({
		backend: AgentIdSchema,
		sessionId: z.string(),
		modeId: z.string(),
	}),
});
export type AiSessionModeSetMsg = z.infer<typeof AiSessionModeSetMsgSchema>;

export const AiAttachmentWriteMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.AI_ATTACHMENT_WRITE),
	clientId: z.string(),
	data: z.object({
		backend: AgentIdSchema,
		sessionId: z.string(),
		name: z.string(),
		content: z.string(),
		mimeType: z.string().startsWith("image/"),
		encoding: z.literal("base64"),
	}),
});
export type AiAttachmentWriteMsg = z.infer<typeof AiAttachmentWriteMsgSchema>;

export const AiAgentsManageListMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.AI_AGENTS_MANAGE_LIST),
	clientId: z.string(),
	data: z.object({}).optional(),
});
export type AiAgentsManageListMsg = z.infer<typeof AiAgentsManageListMsgSchema>;

export const AiAgentsEnableSetMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.AI_AGENTS_ENABLE_SET),
	clientId: z.string(),
	data: z.object({
		backend: AgentIdSchema,
		enabled: z.boolean(),
	}),
});
export type AiAgentsEnableSetMsg = z.infer<typeof AiAgentsEnableSetMsgSchema>;

export const AiAgentsCustomAddMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.AI_AGENTS_CUSTOM_ADD),
	clientId: z.string(),
	data: CustomAcpAgentInputSchema,
});
export type AiAgentsCustomAddMsg = z.infer<typeof AiAgentsCustomAddMsgSchema>;

export const AiAgentsCustomUpdateMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.AI_AGENTS_CUSTOM_UPDATE),
	clientId: z.string(),
	data: CustomAcpAgentInputSchema,
});
export type AiAgentsCustomUpdateMsg = z.infer<
	typeof AiAgentsCustomUpdateMsgSchema
>;

export const AiAgentsCustomRemoveMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.AI_AGENTS_CUSTOM_REMOVE),
	clientId: z.string(),
	data: z.object({
		backend: AgentIdSchema,
	}),
});
export type AiAgentsCustomRemoveMsg = z.infer<
	typeof AiAgentsCustomRemoveMsgSchema
>;

// ── Result messages (CLI → app) ──────────────────────────────────────────────

export const AiSessionLoadResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_SESSION_LOAD_RESULT),
	clientId: z.string(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			backend: AgentIdSchema,
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

function agentManagementResultSchema<TType extends string>(type: TType) {
	return z.object({
		id: z.string().optional(),
		type: z.literal(type),
		clientId: z.string(),
		respTo: z.string().optional(),
		error: z.string().optional(),
		data: AgentManagementResultDataSchema.optional(),
	});
}

export const AiAgentsManageListResultMsgSchema = agentManagementResultSchema(
	MsgType.AI_AGENTS_MANAGE_LIST_RESULT,
);
export type AiAgentsManageListResultMsg = z.infer<
	typeof AiAgentsManageListResultMsgSchema
>;

export const AiAgentsEnableSetResultMsgSchema = agentManagementResultSchema(
	MsgType.AI_AGENTS_ENABLE_SET_RESULT,
);
export type AiAgentsEnableSetResultMsg = z.infer<
	typeof AiAgentsEnableSetResultMsgSchema
>;

export const AiAgentsCustomAddResultMsgSchema = agentManagementResultSchema(
	MsgType.AI_AGENTS_CUSTOM_ADD_RESULT,
);
export type AiAgentsCustomAddResultMsg = z.infer<
	typeof AiAgentsCustomAddResultMsgSchema
>;

export const AiAgentsCustomUpdateResultMsgSchema = agentManagementResultSchema(
	MsgType.AI_AGENTS_CUSTOM_UPDATE_RESULT,
);
export type AiAgentsCustomUpdateResultMsg = z.infer<
	typeof AiAgentsCustomUpdateResultMsgSchema
>;

export const AiAgentsCustomRemoveResultMsgSchema = agentManagementResultSchema(
	MsgType.AI_AGENTS_CUSTOM_REMOVE_RESULT,
);
export type AiAgentsCustomRemoveResultMsg = z.infer<
	typeof AiAgentsCustomRemoveResultMsgSchema
>;

export const AiSessionAttachResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_SESSION_ATTACH_RESULT),
	clientId: z.string(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			backend: AgentIdSchema,
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
	clientId: z.string(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			backend: AgentIdSchema,
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
	clientId: z.string(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			backend: AgentIdSchema,
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
	clientId: z.string(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			backend: AgentIdSchema,
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
	clientId: z.string(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			backend: AgentIdSchema,
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
	clientId: z.string(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			backend: AgentIdSchema,
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
	clientId: z.string(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			backend: AgentIdSchema,
			sessionId: z.string(),
			modeId: z.string(),
			ok: z.literal(true),
		})
		.optional(),
});
export type AiSessionModeSetResultMsg = z.infer<
	typeof AiSessionModeSetResultMsgSchema
>;

export const AiAttachmentWriteResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_ATTACHMENT_WRITE_RESULT),
	clientId: z.string(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			backend: AgentIdSchema,
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

import { z } from "zod";

import { MsgType } from "./base";

// ─── Backend ──────────────────────────────────────────────────────────────────
const _AiBackendSchema = z.enum([
	"opencode",
	"codex",
	"claude-code",
	"copilot",
	"cursor",
	"pi",
	"hermes",
]);
export const AiBackendSchema = z.union([_AiBackendSchema, z.string()]);
export type AiBackend = z.infer<typeof _AiBackendSchema> | (string & {});
export const AI_BACKENDS: AiBackend[] = [
	"opencode",
	"codex",
	"claude-code",
	"copilot",
	"cursor",
	"pi",
	"hermes",
];

// ─── Session ──────────────────────────────────────────────────────────────────

export const AiSessionSchema = z.object({
	id: z.string().optional(),
	createdAt: z.number(),
	updatedAt: z.number(),
	model: z.string().optional(),
	title: z.string().optional(),
	workspacePath: z.string().optional(),
	configOptions: z.array(z.any()).optional(),
});
export type AiSession = z.infer<typeof AiSessionSchema>;

// ─── Message parts ────────────────────────────────────────────────────────────

const AiMessagePartTextSchema = z.object({
	type: z.literal("text"),
	text: z.string(),
});
export type AiMessagePartText = z.infer<typeof AiMessagePartTextSchema>;

const AiMessagePartFileReferenceSchema = z.object({
	id: z.string().optional(),
	type: z.literal("file_reference"),
	path: z.string(),
	range: z
		.object({
			start: z.string(),
			end: z.string(),
		})
		.optional(),
});

const AiMessagePartWebReferenceSchema = z.object({
	id: z.string().optional(),
	url: z.string(),
	type: z.literal("web_reference"),
	title: z.string().optional(),
	content: z.string().optional(),
});
export type AiMessagePartWebReference = z.infer<
	typeof AiMessagePartWebReferenceSchema
>;

const AiMessagePartToolCallSchema = z.object({
	id: z.string().optional(),
	name: z.string(),
	type: z.literal("tool_call"),
	title: z.string().optional(),
	arguments: z.string().optional(),
	status: z.string().optional(),
	output: z.string().optional(),
	parts: z.array(z.unknown()).optional(),
});
export type AiMessagePartToolCall = z.infer<typeof AiMessagePartToolCallSchema>;

const AiMessagePartImageSchema = z.object({
	id: z.string().optional(),
	type: z.literal("image"),
	src: z.string(),
	alt: z.string().optional(),
	mime: z.string().optional(),
});
export type AiMessagePartImage = z.infer<typeof AiMessagePartImageSchema>;

const AiMessagePartFileChangeSchema = z.object({
	id: z.string().optional(),
	type: z.literal("file_change"),
	path: z.string(),
	kind: z.string(),
	diff: z
		.object({
			old: z.string(),
			new: z.string(),
		})
		.optional(),
	status: z.string().optional(),
});
export type AiMessagePartFileChange = z.infer<
	typeof AiMessagePartFileChangeSchema
>;

const AiMessagePartCommandSchema = z.object({
	id: z.string().optional(),
	type: z.literal("command"),
	command: z.string(),
	cwd: z.string().optional(),
	output: z.string().optional(),
	exitCode: z.number().optional(),
	status: z.string().optional(),
});
export type AiMessagePartCommand = z.infer<typeof AiMessagePartCommandSchema>;

const AiMessagePartReasoningSchema = z.object({
	type: z.literal("reasoning"),
	content: z.string(),
	summary: z.string().optional(),
});
export type AiMessagePartReasoning = z.infer<
	typeof AiMessagePartReasoningSchema
>;

const AiMessagePartPlanSchema = z.object({
	type: z.literal("plan"),
	content: z.string(),
	summary: z.string().optional(),
});
export type AiMessagePartPlan = z.infer<typeof AiMessagePartPlanSchema>;

export const AiMessagePartSchema = z.discriminatedUnion("type", [
	AiMessagePartTextSchema,
	AiMessagePartFileReferenceSchema,
	AiMessagePartWebReferenceSchema,
	AiMessagePartToolCallSchema,
	AiMessagePartImageSchema,
	AiMessagePartFileChangeSchema,
	AiMessagePartCommandSchema,
	AiMessagePartReasoningSchema,
	AiMessagePartPlanSchema,
]);
export type AiMessagePart = z.infer<typeof AiMessagePartSchema>;

export const AiMessageSchema = z
	.object({
		id: z.string().optional(),
		role: z.enum(["user", "assistant"]),
		parts: z.array(AiMessagePartSchema).default([]),
		timestamp: z.number().optional(),
	})
	.catchall(z.unknown());
export type AiMessage = z.infer<typeof AiMessageSchema>;

// ─── Loose shared types ───────────────────────────────────────────────────────

/** Streaming event emitted by an AI backend */
export const AiSessionRuntimeStatusSchema = z.enum([
	"starting",
	"running",
	"waiting_for_permission",
	"stopping",
	"stopped",
	"finished",
	"error",
	"cancelled",
]);
export type AiSessionRuntimeStatus = z.infer<
	typeof AiSessionRuntimeStatusSchema
>;

export const AiSessionRuntimeStateSchema = z.object({
	status: AiSessionRuntimeStatusSchema,
	agentId: AiBackendSchema,
	sessionId: z.string(),
	updatedAt: z.number(),
	title: z.string().optional(),
	workspacePath: z.string().optional(),
	model: z.string().optional(),
	message: z.string().optional(),
	stopReason: z.string().optional(),
	error: z.string().optional(),
	pendingPermission: z.record(z.string(), z.unknown()).optional(),
});
export type AiSessionRuntimeState = z.infer<typeof AiSessionRuntimeStateSchema>;

export const AiEventSchema = z.object({
	type: z.string(),
	properties: z.record(z.string(), z.unknown()),
	state: AiSessionRuntimeStateSchema.optional(),
});
export type AiEvent = z.infer<typeof AiEventSchema>;

export const ShareInfoSchema = z.record(z.string(), z.unknown());
export type ShareInfo = z.infer<typeof ShareInfoSchema>;

export const ProviderInfoSchema = z
	.object({
		providers: z.array(z.unknown()),
		default: z.record(z.string(), z.string()),
	})
	.catchall(z.unknown());
export type ProviderInfo = z.infer<typeof ProviderInfoSchema>;

// ─── Incoming (client → CLI) ──────────────────────────────────────────────────

export const AiAvailabilityMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_AVAILABILITY),
	clientId: z.string(),
});
export type AiAvailabilityMsg = z.infer<typeof AiAvailabilityMsgSchema>;

export const AiSessionListMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_SESSION_LIST),
	clientId: z.string(),
	data: z
		.object({
			backend: AiBackendSchema,
			workspace: z.string().optional(),
			cursor: z.string().optional(),
		})
		.optional(),
});
export type AiSessionListMsg = z.infer<typeof AiSessionListMsgSchema>;

export const AiSessionCreateMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_SESSION_CREATE),
	clientId: z.string(),
	data: z.object({
		backend: AiBackendSchema,
		prompt: z.string(),
		content: z.array(z.unknown()).optional(),
		workspacePath: z.string(),
		cwd: z.string().optional(),
		additionalDirectories: z.array(z.string()).optional(),
		mcpServers: z.array(z.record(z.string(), z.unknown())).optional(),
		model: z.any().optional(),
	}),
});
export type AiSessionCreateMsg = z.infer<typeof AiSessionCreateMsgSchema>;

export const AiSessionGetMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_SESSION_GET),
	clientId: z.string(),
	data: z.object({
		backend: AiBackendSchema,
		sessionId: z.string(),
	}),
});
export type AiSessionGetMsg = z.infer<typeof AiSessionGetMsgSchema>;

export const AiSessionDeleteMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_SESSION_DELETE),
	clientId: z.string(),
	data: z.object({
		backend: AiBackendSchema,
		sessionId: z.string(),
	}),
});
export type AiSessionDeleteMsg = z.infer<typeof AiSessionDeleteMsgSchema>;

export const AiMessagesListMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_MESSAGES_LIST),
	clientId: z.string(),
	data: z.object({
		backend: AiBackendSchema,
		sessionId: z.string(),
	}),
});
export type AiMessagesListMsg = z.infer<typeof AiMessagesListMsgSchema>;

export const AiPromptMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_PROMPT),
	clientId: z.string(),
	data: z.object({
		backend: AiBackendSchema,
		sessionId: z.string(),
		text: z.string(),
		content: z.array(z.unknown()).optional(),
		model: z.any().optional(),
		agent: z.string().optional(),
		files: z.any().optional(),
		codexOptions: z.any().optional(),
		requestId: z.string().optional(),
	}),
});
export type AiPromptMsg = z.infer<typeof AiPromptMsgSchema>;

export const AiAbortMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_ABORT),
	clientId: z.string(),
	data: z.object({
		backend: AiBackendSchema,
		sessionId: z.string(),
	}),
});
export type AiAbortMsg = z.infer<typeof AiAbortMsgSchema>;

export const AiAgentsListMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_AGENTS_LIST),
	clientId: z.string(),
	data: z.object({
		backend: AiBackendSchema.optional(),
	}),
});
export type AiAgentsListMsg = z.infer<typeof AiAgentsListMsgSchema>;

export const AiActivityListMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_ACTIVITY_LIST),
	clientId: z.string(),
	data: z
		.object({
			backend: AiBackendSchema.optional(),
		})
		.optional(),
});
export type AiActivityListMsg = z.infer<typeof AiActivityListMsgSchema>;

export const AiProvidersListMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_PROVIDERS_LIST),
	clientId: z.string(),
	data: z.object({
		backend: AiBackendSchema.optional(),
	}),
});
export type AiProvidersListMsg = z.infer<typeof AiProvidersListMsgSchema>;

export const AiAuthSetMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_AUTH_SET),
	clientId: z.string(),
	data: z.object({
		backend: AiBackendSchema,
		providerId: z.string(),
		key: z.string(),
	}),
});
export type AiAuthSetMsg = z.infer<typeof AiAuthSetMsgSchema>;

export const AiCommandMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_COMMAND),
	clientId: z.string(),
	data: z.object({
		backend: AiBackendSchema,
		sessionId: z.string(),
		command: z.string(),
		args: z.array(z.string()).optional(),
	}),
});
export type AiCommandMsg = z.infer<typeof AiCommandMsgSchema>;

export const AiRevertMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_REVERT),
	clientId: z.string(),
	data: z.object({
		backend: AiBackendSchema,
		sessionId: z.string(),
		messageId: z.string(),
	}),
});
export type AiRevertMsg = z.infer<typeof AiRevertMsgSchema>;

export const AiUnrevertMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_UNREVERT),
	clientId: z.string(),
	data: z.object({
		backend: AiBackendSchema,
		sessionId: z.string(),
	}),
});
export type AiUnrevertMsg = z.infer<typeof AiUnrevertMsgSchema>;

export const AiShareMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_SHARE),
	clientId: z.string(),
	data: z.object({
		backend: AiBackendSchema,
		sessionId: z.string(),
	}),
});
export type AiShareMsg = z.infer<typeof AiShareMsgSchema>;

export const AiPermissionReplyMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_PERMISSION_REPLY),
	clientId: z.string(),
	data: z.union([
		z.object({
			backend: AiBackendSchema,
			sessionId: z.string(),
			permissionId: z.string(),
			optionId: z.string(),
		}),
		z.object({
			backend: AiBackendSchema,
			sessionId: z.string(),
			permissionId: z.string(),
			response: z.enum(["once", "always", "reject"]),
		}),
	]),
});
export type AiPermissionReplyMsg = z.infer<typeof AiPermissionReplyMsgSchema>;

export const AiQuestionReplyMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_QUESTION_REPLY),
	clientId: z.string(),
	data: z.object({
		backend: AiBackendSchema,
		sessionId: z.string(),
		questionId: z.string(),
		answers: z.array(z.array(z.string())),
	}),
});
export type AiQuestionReplyMsg = z.infer<typeof AiQuestionReplyMsgSchema>;

export const AiQuestionRejectMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_QUESTION_REJECT),
	clientId: z.string(),
	data: z.object({
		backend: AiBackendSchema,
		sessionId: z.string(),
		questionId: z.string(),
	}),
});
export type AiQuestionRejectMsg = z.infer<typeof AiQuestionRejectMsgSchema>;

// ─── Outgoing (CLI → client) ──────────────────────────────────────────────────

export const AiAvailabilityResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_AVAILABILITY_RESULT),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z.object({
		backends: z.array(AiBackendSchema),
	}),
});
export type AiAvailabilityResultMsg = z.infer<
	typeof AiAvailabilityResultMsgSchema
>;

export const AiSessionListResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_SESSION_LIST_RESULT),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			sessions: z.array(AiSessionSchema),
			nextCursor: z.string().optional(),
		})
		.optional(),
});
export type AiSessionListResultMsg = z.infer<
	typeof AiSessionListResultMsgSchema
>;

export const AiSessionCreateResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_SESSION_CREATE_RESULT),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			session: AiSessionSchema,
			state: z.record(z.string(), z.unknown()).optional(),
			runtimeState: AiSessionRuntimeStateSchema.optional(),
		})
		.optional(),
});
export type AiSessionCreateResultMsg = z.infer<
	typeof AiSessionCreateResultMsgSchema
>;

export const AiSessionGetResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_SESSION_GET_RESULT),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			backend: AiBackendSchema,
			session: z.unknown(),
		})
		.optional(),
});
export type AiSessionGetResultMsg = z.infer<typeof AiSessionGetResultMsgSchema>;

export const AiSessionDeletedMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_SESSION_DELETED),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			deleted: z.boolean(),
		})
		.optional(),
});
export type AiSessionDeletedMsg = z.infer<typeof AiSessionDeletedMsgSchema>;

export const AiMessagesListResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_MESSAGES_LIST_RESULT),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			backend: AiBackendSchema,
			messages: z.array(z.unknown()),
		})
		.optional(),
});
export type AiMessagesListResultMsg = z.infer<
	typeof AiMessagesListResultMsgSchema
>;

export const AiEventMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_EVENT),
	clientId: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			backend: AiBackendSchema,
			type: z.string(),
			state: AiSessionRuntimeStateSchema.optional(),
			properties: z
				.object({
					sessionId: z.string(),
				})
				.catchall(z.unknown()),
		})
		.optional(),
});
export type AiEventMsg = z.infer<typeof AiEventMsgSchema>;

export const AiPromptAckMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_PROMPT_ACK),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			ack: z.boolean(),
			backend: AiBackendSchema.optional(),
			sessionId: z.string().optional(),
		})
		.optional(),
});
export type AiPromptAckMsg = z.infer<typeof AiPromptAckMsgSchema>;

export const AiAbortAckMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_ABORT_ACK),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			ok: z.literal(true),
		})
		.optional(),
});
export type AiAbortAckMsg = z.infer<typeof AiAbortAckMsgSchema>;

export const AiAgentsListResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_AGENTS_LIST_RESULT),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			agents: z.unknown(),
		})
		.optional(),
});
export type AiAgentsListResultMsg = z.infer<typeof AiAgentsListResultMsgSchema>;

export const AiActivityListResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_ACTIVITY_LIST_RESULT),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			activities: z.array(AiSessionRuntimeStateSchema),
		})
		.optional(),
});
export type AiActivityListResultMsg = z.infer<
	typeof AiActivityListResultMsgSchema
>;

export const AiProvidersListResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_PROVIDERS_LIST_RESULT),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			providers: ProviderInfoSchema,
		})
		.optional(),
});
export type AiProvidersListResultMsg = z.infer<
	typeof AiProvidersListResultMsgSchema
>;

export const AiAuthSetAckMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_AUTH_SET_ACK),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			ok: z.literal(true),
		})
		.optional(),
});
export type AiAuthSetAckMsg = z.infer<typeof AiAuthSetAckMsgSchema>;

export const AiCommandResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_COMMAND_RESULT),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			result: z.unknown(),
		})
		.optional(),
});
export type AiCommandResultMsg = z.infer<typeof AiCommandResultMsgSchema>;

export const AiRevertAckMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_REVERT_ACK),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			ok: z.literal(true),
		})
		.optional(),
});
export type AiRevertAckMsg = z.infer<typeof AiRevertAckMsgSchema>;

export const AiUnrevertAckMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_UNREVERT_ACK),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			ok: z.literal(true),
		})
		.optional(),
});
export type AiUnrevertAckMsg = z.infer<typeof AiUnrevertAckMsgSchema>;

export const AiShareResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_SHARE_RESULT),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			share: ShareInfoSchema,
		})
		.optional(),
});
export type AiShareResultMsg = z.infer<typeof AiShareResultMsgSchema>;

export const AiPermissionReplyAckMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_PERMISSION_REPLY_ACK),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			ok: z.literal(true),
		})
		.optional(),
});
export type AiPermissionReplyAckMsg = z.infer<
	typeof AiPermissionReplyAckMsgSchema
>;

export const AiQuestionReplyAckMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_QUESTION_REPLY_ACK),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			ok: z.literal(true),
		})
		.optional(),
});
export type AiQuestionReplyAckMsg = z.infer<typeof AiQuestionReplyAckMsgSchema>;

export const AiQuestionRejectAckMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.AI_QUESTION_REJECT_ACK),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			ok: z.literal(true),
		})
		.optional(),
});
export type AiQuestionRejectAckMsg = z.infer<
	typeof AiQuestionRejectAckMsgSchema
>;

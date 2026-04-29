import { z } from "zod";

import { MsgType } from "./base";

// ─── Host info ───────────────────────────────────────────────────────────────

export const HostInfoSchema = z.object({
	id: z.string(),
	hostname: z.string(),
	username: z.string(),
	platform: z.string(),
	dir: z.string(),
	machineId: z.string(),
});
export type HostInfo = z.infer<typeof HostInfoSchema>;

// ─── Outgoing (CLI → server → client) ────────────────────────────────────────

export const SessionHostMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.SESSION_HOST),
	data: HostInfoSchema,
});
export type SessionHostMsg = z.infer<typeof SessionHostMsgSchema>;

export const SessionHostedMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.SESSION_HOSTED),
	data: z.object({
		sessionId: z.string(),
	}),
});
export type SessionHostedMsg = z.infer<typeof SessionHostedMsgSchema>;

export const SessionJoinedMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.SESSION_JOINED),
	respTo: z.string().optional(),
	data: z.object({
		username: z.string(),
		hostname: z.string(),
		platform: z.string(),
		dir: z.string(),
		machineId: z.string(),
		sessionId: z.string(),
	}),
});
export type SessionJoinedMsg = z.infer<typeof SessionJoinedMsgSchema>;

export const SessionErrorMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.SESSION_ERROR),
	respTo: z.string().optional(),
	error: z.string(),
});
export type SessionErrorMsg = z.infer<typeof SessionErrorMsgSchema>;

export const ClientInfoSchema = z.object({
	hostId: z.string(),
	clientId: z.string(),
	appVersion: z.string(),
	platform: z.string(),
	deviceModel: z.string(),
	deviceIsEmulator: z.union([
		z.boolean(),
		z.enum(["true", "false"]).transform((val) => val === "true"),
	]),
	deviceManufacturer: z.string(),
});
export type ClientInfo = z.infer<typeof ClientInfoSchema>;

export const SessionClientJoinedMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.SESSION_CLIENT_JOINED),
	data: ClientInfoSchema,
});
export type SessionClientJoinedMsg = z.infer<
	typeof SessionClientJoinedMsgSchema
>;

export const SessionClientLeftMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.SESSION_CLIENT_LEFT),
	data: z.object({
		clientId: z.string(),
	}),
});
export type SessionClientLeftMsg = z.infer<typeof SessionClientLeftMsgSchema>;

// ─── Incoming (client → CLI) ──────────────────────────────────────────────────

export const SessionClientJoinMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.SESSION_CLIENT_JOIN),
	data: ClientInfoSchema,
});
export type SessionClientJoinMsg = z.infer<typeof SessionClientJoinMsgSchema>;

export const SessionClientJoinResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.SESSION_CLIENT_JOIN_RESULT),
	data: z.object({
		clientId: z.string(),
		approved: z.boolean(),
	}),
});
export type SessionClientJoinResultMsg = z.infer<
	typeof SessionClientJoinResultMsgSchema
>;

// ─── Handshake union ─────────────────────────────────────────────────────────

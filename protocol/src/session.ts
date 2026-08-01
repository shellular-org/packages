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
	/** Version of the Shellular CLI running on the host. */
	cliVersion: z.string().optional(),
	/**
	 * True when the CLI can safely update + restart itself in place — i.e. it is
	 * running under a supervisor (the daemon/PM2). For a foreground `npx`/global
	 * launch this is false: the app should tell the user to update manually
	 * rather than risk orphaning the process.
	 */
	canSelfUpdate: z.boolean().optional(),
});
export type HostInfo = z.infer<typeof HostInfoSchema>;

// ─── Outgoing (CLI → server → client) ────────────────────────────────────────

export const SessionHostMsgSchema = z.object({
	id: z.string(),
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
	// The server spreads the host's HostInfo into this message and adds sessionId,
	// so reuse HostInfoSchema in full rather than redeclaring its fields.
	data: HostInfoSchema.extend({
		sessionId: z.string(),
		/** True when a newer CLI version is available on npm. */
		updateAvailable: z.boolean().optional(),
		/** Latest CLI version published on npm, when known. */
		latestCliVersion: z.string().optional(),
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

/**
 * The authenticated account behind a connecting client. Established by the
 * server from the caller's session — never from client-supplied input — so the
 * CLI host can trust it when deciding whether to approve a connection.
 */
export const ClientUserInfoSchema = z.object({
	id: z.string().min(1),
	email: z.email(),
});
export type ClientUserInfo = z.infer<typeof ClientUserInfoSchema>;

export const ClientInfoSchema = z.object({
	hostId: z.string().min(7).max(32),
	clientId: z.string().min(7).max(32),
	appVersion: z.string().min(1).max(32),
	platform: z.enum(["android", "browser", "ios", "macos"]),
	deviceModel: z.string().min(1).max(64),
	deviceIsEmulator: z.union([
		z.boolean(),
		z.enum(["true", "false"]).transform((val) => val === "true"),
	]),
	deviceManufacturer: z.string().min(1).max(128),
});
export type ClientInfo = z.infer<typeof ClientInfoSchema>;

/**
 * Client info for an authenticated connection, where `user` is guaranteed
 * present. Use this to type values downstream of the server's identity
 * injection so the compiler enforces that the lookup happened.
 */
export const AuthedClientInfoSchema = ClientInfoSchema.extend({
	user: ClientUserInfoSchema,
});
export type AuthedClientInfo = z.infer<typeof AuthedClientInfoSchema>;

export const SessionClientJoinedMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.SESSION_CLIENT_JOINED),
	data: AuthedClientInfoSchema,
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
	data: AuthedClientInfoSchema,
});
export type SessionClientJoinMsg = z.infer<typeof SessionClientJoinMsgSchema>;

export const SessionClientJoinResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.SESSION_CLIENT_JOIN_RESULT),
	data: z.object({
		clientId: z.string(),
		approved: z.boolean(),
		// The server merges these into session.hostInfo before sending
		// SESSION_JOINED, so the joining app always sees current update status —
		// even for a long-lived daemon which might have been the latest when it was started
		updateAvailable: z.boolean().optional(),
		latestCliVersion: z.string().optional(),
	}),
});
export type SessionClientJoinResultMsg = z.infer<
	typeof SessionClientJoinResultMsgSchema
>;

// ─── Handshake union ─────────────────────────────────────────────────────────

/**
 * ServerCloseCodeAndReason defines the WebSocket close codes and reasons
 * used by the server during the handshake process.
 */
export const ServerCloseCodeAndReason = {
	/**
	 * The host is not connected to the Shellular server, so the client cannot connect to it.
	 */
	HOST_UNAVAILABLE: { code: 4001, reason: "host_unavailable" },
	/**
	 * The client sent an invalid query during the handshake, such as a malformed request or missing required parameters.
	 */
	INVALID_QUERY: { code: 4002, reason: "invalid_query" },
	/**
	 * The client was denied approval to connect by the host.
	 */
	APPROVAL_DENIED: { code: 4003, reason: "approval_denied" },
	SESSION_JOIN_FAILED: { code: 4004, reason: "session_join_failed" },
	/**
	 * The client was connected, the session was on, but the host got disconnected mid-session (e.g. the host's CLI crashed or was killed).
	 * The client should treat this as a temporary failure and retry the connection.
	 */
	HOST_DISCONNECTED: { code: 4005, reason: "host_disconnected" },
	CLIENT_REPLACED: { code: 4006, reason: "client_replaced" },
	/**
	 * The host failed authentication, e.g., due to invalid info or expired token.
	 */
	HOST_AUTH_FAILED: { code: 4007, reason: "host_auth_failed" },
} as const;

export type ServerCloseCodeAndReasonValue =
	(typeof ServerCloseCodeAndReason)[keyof typeof ServerCloseCodeAndReason];

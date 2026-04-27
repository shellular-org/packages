import { z } from "zod";

export const MsgType = {
	/** CLI sends this to register itself as a host with the server */
	SESSION_HOST: "session:host",
	/** Server response confirming CLI is registered as a host */
	SESSION_HOSTED: "session:hosted",
	/** Used by app side after joining a session */
	SESSION_JOINED: "session:joined",
	/** Error response during session establishment */
	SESSION_ERROR: "session:error",
	/** Server notifies CLI when a client (app) joins the session */
	SESSION_CLIENT_JOINED: "session:client-joined",
	/** Server notifies CLI when a client (app) leaves the session */
	SESSION_CLIENT_LEFT: "session:client-left",
	/** Server notifies CLI of a pending client connection awaiting approval */
	SESSION_CLIENT_JOIN: "session:client-join",
	/** CLI sends this to report whether a pending client was approved */
	SESSION_CLIENT_JOIN_RESULT: "session:client-join:result",
	/** Request to list directory contents */
	FS_LIST: "fs:list",
	/** Response with directory listing entries */
	FS_LIST_RESULT: "fs:list:result",
	/** Request to read a file */
	FS_READ: "fs:read",
	/** Response with file content */
	FS_READ_RESULT: "fs:read:result",
	/** Request to write to a file */
	FS_WRITE: "fs:write",
	/** Response after file write completes */
	FS_WRITE_RESULT: "fs:write:result",
	/** Request to create a directory */
	FS_MKDIR: "fs:mkdir",
	/** Request to delete a file or directory */
	FS_DELETE: "fs:delete",
	/** Request to rename a file or directory */
	FS_RENAME: "fs:rename",
	/** Request to get file/directory stats */
	FS_STAT: "fs:stat",
	/** Response with file/directory stats */
	FS_STAT_RESULT: "fs:stat:result",
	/** Generic response for mkdir/delete/rename operations */
	FS_RESULT: "fs:result",
	/** Request to create a new terminal session */
	TERMINAL_CREATE: "terminal:create",
	/** Response confirming terminal creation with terminal ID */
	TERMINAL_CREATE_RESULT: "terminal:create:result",
	/** Request to list all active terminals */
	TERMINAL_LIST: "terminal:list",
	/** Response with list of active terminals */
	TERMINAL_LIST_RESULT: "terminal:list:result",
	/** Request to attach to an existing terminal */
	TERMINAL_ATTACH: "terminal:attach",
	/** Response confirming attachment with buffer content */
	TERMINAL_ATTACH_RESULT: "terminal:attach:result",
	/** Terminal output data streamed from CLI to client / input from client to CLI */
	TERMINAL_DATA: "terminal:data",
	/** Request to resize terminal dimensions */
	TERMINAL_RESIZE: "terminal:resize",
	/** Terminal title change notification */
	TERMINAL_TITLE: "terminal:title",
	/** Request to close a terminal session */
	TERMINAL_CLOSE: "terminal:close",
	/** Response confirming terminal is closed */
	TERMINAL_CLOSED: "terminal:closed",
	/** Request to fetch system info */
	SYSMON_GET: "sysmon:get",
	/** Response with system info */
	SYSMON_RESULT: "sysmon:result",
	/** Streamed battery percentage update */
	BATTERY_UPDATE: "battery:update",
	HTTP_REQUEST: "http:request",
	HTTP_RESPONSE_START: "http:response:start",
	HTTP_RESPONSE_DATA: "http:response:data",
	HTTP_RESPONSE_END: "http:response:end",
	WS_OPEN: "ws:open",
	WS_OPENED: "ws:opened",
	WS_DATA: "ws:data",
	WS_CLOSE: "ws:close",
	WS_CLOSED: "ws:closed",
	PING: "ping",
	PONG: "pong",
	PORTS_LIST: "ports:list",
	PORTS_LIST_RESULT: "ports:list:result",
	PORTS_KILL: "ports:kill",
	PORTS_KILL_RESULT: "ports:kill:result",
	/** Request to get git info for a project directory */
	PROJECT_INFO: "project:info",
	/** Response with git info for a project directory */
	PROJECT_INFO_RESULT: "project:info:result",
	/** Request to search project files */
	PROJECT_FILE_SEARCH: "project:file-search",
	/** Response with project file search results */
	PROJECT_FILE_SEARCH_RESULT: "project:file-search:result",
	/** Request to read original file content from git */
	GIT_READ: "git:read",
	/** Response with original file content from git */
	GIT_READ_RESULT: "git:read:result",
	AI_AVAILABILITY: "ai:availability",
	AI_AVAILABILITY_RESULT: "ai:availability:result",
	AI_SESSION_LIST: "ai:session:list",
	AI_SESSION_LIST_RESULT: "ai:session:list:result",
	AI_SESSION_CREATE: "ai:session:create",
	AI_SESSION_CREATE_RESULT: "ai:session:create:result",
	AI_SESSION_LOAD: "ai:session:load",
	AI_SESSION_LOAD_RESULT: "ai:session:load:result",
	AI_SESSION_RESUME: "ai:session:resume",
	AI_SESSION_RESUME_RESULT: "ai:session:resume:result",
	AI_SESSION_FORK: "ai:session:fork",
	AI_SESSION_FORK_RESULT: "ai:session:fork:result",
	AI_SESSION_CLOSE: "ai:session:close",
	AI_SESSION_CLOSE_RESULT: "ai:session:close:result",
	AI_SESSION_MODE_SET: "ai:session:mode:set",
	AI_SESSION_MODE_SET_RESULT: "ai:session:mode:set:result",
	AI_SESSION_MODEL_SET: "ai:session:model:set",
	AI_SESSION_MODEL_SET_RESULT: "ai:session:model:set:result",
	AI_SESSION_GET: "ai:session:get",
	AI_SESSION_GET_RESULT: "ai:session:get:result",
	AI_SESSION_DELETE: "ai:session:delete",
	AI_SESSION_DELETED: "ai:session:deleted",
	AI_MESSAGES_LIST: "ai:messages:list",
	AI_MESSAGES_LIST_RESULT: "ai:messages:list:result",
	AI_PROMPT: "ai:prompt",
	AI_PROMPT_ACK: "ai:prompt:ack",
	AI_SESSION_CONFIG_SET: "ai:session:config:set",
	AI_SESSION_CONFIG_SET_RESULT: "ai:session:config:set:result",
	AI_ABORT: "ai:abort",
	AI_ABORT_ACK: "ai:abort:ack",
	AI_EVENT: "ai:event",
	AI_AGENTS_LIST: "ai:agents:list",
	AI_AGENTS_LIST_RESULT: "ai:agents:list:result",
	AI_PROVIDERS_LIST: "ai:providers:list",
	AI_PROVIDERS_LIST_RESULT: "ai:providers:list:result",
	AI_AUTH_SET: "ai:auth:set",
	AI_AUTH_SET_ACK: "ai:auth:set:ack",
	AI_COMMAND: "ai:command",
	AI_COMMAND_RESULT: "ai:command:result",
	AI_REVERT: "ai:revert",
	AI_REVERT_ACK: "ai:revert:ack",
	AI_UNREVERT: "ai:unrevert",
	AI_UNREVERT_ACK: "ai:unrevert:ack",
	AI_SHARE: "ai:share",
	AI_SHARE_RESULT: "ai:share:result",
	AI_PERMISSION_REPLY: "ai:permission:reply",
	AI_PERMISSION_REPLY_ACK: "ai:permission:reply:ack",
	AI_QUESTION_REPLY: "ai:question:reply",
	AI_QUESTION_REPLY_ACK: "ai:question:reply:ack",
	AI_QUESTION_REJECT: "ai:question:reject",
	AI_QUESTION_REJECT_ACK: "ai:question:reject:ack",
	ENCRYPTED: "encrypted",
} as const;

export type MsgType = (typeof MsgType)[keyof typeof MsgType];

export const PLAINTEXT_TYPES: ReadonlySet<string> = new Set([
	MsgType.SESSION_HOST,
	MsgType.SESSION_HOSTED,
	MsgType.SESSION_JOINED,
	MsgType.SESSION_ERROR,
	MsgType.SESSION_CLIENT_JOINED,
	MsgType.SESSION_CLIENT_LEFT,
	MsgType.SESSION_CLIENT_JOIN,
	MsgType.SESSION_CLIENT_JOIN_RESULT,
	MsgType.PING,
	MsgType.PONG,
]);

export const BaseMsgSchema = z
	.object({
		id: z.string().optional(),
		type: z.string(),
	})
	.catchall(z.unknown());

// ─── Ping / Pong ─────────────────────────────────────────────────────────────

export const PingMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.PING),
});
export type PingMsg = z.infer<typeof PingMsgSchema>;

export const PongMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.PONG),
	respTo: z.string().optional(),
});
export type PongMsg = z.infer<typeof PongMsgSchema>;

// ─── Encrypted ───────────────────────────────────────────────────────────────

export const EncryptedMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.ENCRYPTED),
	clientId: z.string().optional(),
	nonce: z.string(),
	ciphertext: z.string(),
});
export type EncryptedMsg = z.infer<typeof EncryptedMsgSchema>;

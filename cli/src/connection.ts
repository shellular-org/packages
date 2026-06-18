import { EventEmitter } from "node:events";

import type { HostInfo } from "@shellular/protocol";
import {
	type AiAbortMsg,
	type AiActivityDismissMsg,
	type AiActivityListMsg,
	type AiAgentsCustomAddMsg,
	type AiAgentsCustomRemoveMsg,
	type AiAgentsCustomUpdateMsg,
	type AiAgentsEnableSetMsg,
	type AiAgentsListMsg,
	type AiAgentsManageListMsg,
	type AiAttachmentWriteMsg,
	type AiAuthSetMsg,
	type AiAvailabilityMsg,
	type AiCommandMsg,
	type AiMessagesListMsg,
	type AiPermissionReplyMsg,
	type AiPromptMsg,
	type AiProvidersListMsg,
	type AiQuestionRejectMsg,
	type AiQuestionReplyMsg,
	type AiRevertMsg,
	type AiSessionAttachMsg,
	type AiSessionCloseMsg,
	type AiSessionConfigSetMsg,
	type AiSessionCreateMsg,
	type AiSessionDeleteMsg,
	type AiSessionDetachMsg,
	type AiSessionForkMsg,
	type AiSessionGetMsg,
	type AiSessionListMsg,
	type AiSessionLoadMsg,
	type AiSessionModeSetMsg,
	type AiSessionResumeMsg,
	type AiShareMsg,
	type AiUnrevertMsg,
	BaseMsgSchema,
	EncryptedMsgSchema,
	type FsDeleteMsg,
	type FsListMsg,
	type FsMkdirMsg,
	type FsReadMsg,
	type FsRenameMsg,
	type FsStatMsg,
	type FsWriteMsg,
	type GitCommitFileDiffMsg,
	type GitCommitFilesMsg,
	type GitLogMsg,
	type GitReadMsg,
	type HostHandshakeMsg,
	HostHandshakeRespMsgSchema,
	type HostIncomingMsg,
	HostIncomingMsgSchema,
	type HostToClientMsg,
	type HostToServerMsg,
	type HttpRequestMsg,
	MsgType,
	PLAINTEXT_TYPES,
	type PortsKillMsg,
	type PortsListMsg,
	type ProjectFileSearchMsg,
	type ProjectInfoMsg,
	parseMessage,
	type SessionClientJoinedMsg,
	type SessionClientJoinMsg,
	type SessionClientLeftMsg,
	type SessionErrorMsg,
	type SessionHostMsg,
	type SysmonGetMsg,
	type TerminalAttachMsg,
	type TerminalCloseMsg,
	type TerminalCreateMsg,
	type TerminalDataMsg,
	type TerminalListMsg,
	type TerminalResizeMsg,
	type WsCloseMsg,
	type WsDataMsg,
	type WsOpenMsg,
} from "@shellular/protocol";
import { nanoid } from "nanoid";
import WebSocket from "ws";
import { ConnectedClients } from "@/clients/connected";
import { config } from "@/config";
import { decrypt, encrypt } from "@/encryption";
import { logger } from "@/logger";

const HEARTBEAT_INTERVAL_MS = 25_000;

export interface DisconnectInfo {
	code: number;
	reason: string;
}

type OutgoingMsg = HostToClientMsg | HostToServerMsg;
type SendableMsg = {
	[TType in OutgoingMsg["type"]]: Omit<
		Extract<OutgoingMsg, { type: TType }>,
		"id"
	>;
}[OutgoingMsg["type"]];

export class Connection extends EventEmitter {
	hostInfo: HostInfo;
	sessionId: string;
	ws: WebSocket;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	clients: ConnectedClients;

	constructor(serverUrl: string | URL, hostInfo: HostInfo) {
		super();
		this.hostInfo = hostInfo;
		this.sessionId = "";
		this.clients = new ConnectedClients();

		const wsUrl = new URL(serverUrl);
		if (hostInfo.id) {
			wsUrl.searchParams.set("hostId", hostInfo.id);
		}

		this.ws = new WebSocket(wsUrl.toString());
	}

	on(
		eventName: typeof MsgType.SESSION_HOSTED,
		listener: (msg: HostHandshakeMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.SESSION_ERROR,
		listener: (msg: SessionErrorMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.SESSION_CLIENT_JOINED,
		listener: (msg: SessionClientJoinedMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.SESSION_CLIENT_LEFT,
		listener: (msg: SessionClientLeftMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.SESSION_CLIENT_JOIN,
		listener: (msg: SessionClientJoinMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.SYSMON_GET,
		listener: (msg: SysmonGetMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.TERMINAL_CREATE,
		listener: (msg: TerminalCreateMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.TERMINAL_LIST,
		listener: (msg: TerminalListMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.TERMINAL_ATTACH,
		listener: (msg: TerminalAttachMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.TERMINAL_DATA,
		listener: (msg: TerminalDataMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.TERMINAL_RESIZE,
		listener: (msg: TerminalResizeMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.TERMINAL_CLOSE,
		listener: (msg: TerminalCloseMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.FS_LIST,
		listener: (msg: FsListMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.FS_READ,
		listener: (msg: FsReadMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.FS_WRITE,
		listener: (msg: FsWriteMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.FS_MKDIR,
		listener: (msg: FsMkdirMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.FS_DELETE,
		listener: (msg: FsDeleteMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.FS_RENAME,
		listener: (msg: FsRenameMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.FS_STAT,
		listener: (msg: FsStatMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.PROJECT_INFO,
		listener: (msg: ProjectInfoMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.PROJECT_FILE_SEARCH,
		listener: (msg: ProjectFileSearchMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.GIT_READ,
		listener: (msg: GitReadMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.GIT_LOG,
		listener: (msg: GitLogMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.GIT_COMMIT_FILES,
		listener: (msg: GitCommitFilesMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.GIT_COMMIT_FILE_DIFF,
		listener: (msg: GitCommitFileDiffMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.PORTS_LIST,
		listener: (msg: PortsListMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.PORTS_KILL,
		listener: (msg: PortsKillMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.HTTP_REQUEST,
		listener: (msg: HttpRequestMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.WS_OPEN,
		listener: (msg: WsOpenMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.WS_DATA,
		listener: (msg: WsDataMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.WS_CLOSE,
		listener: (msg: WsCloseMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_AVAILABILITY,
		listener: (msg: AiAvailabilityMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_SESSION_LIST,
		listener: (msg: AiSessionListMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_SESSION_CREATE,
		listener: (msg: AiSessionCreateMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_SESSION_LOAD,
		listener: (msg: AiSessionLoadMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_SESSION_ATTACH,
		listener: (msg: AiSessionAttachMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_SESSION_DETACH,
		listener: (msg: AiSessionDetachMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_SESSION_RESUME,
		listener: (msg: AiSessionResumeMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_SESSION_FORK,
		listener: (msg: AiSessionForkMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_SESSION_CLOSE,
		listener: (msg: AiSessionCloseMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_SESSION_GET,
		listener: (msg: AiSessionGetMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_SESSION_DELETE,
		listener: (msg: AiSessionDeleteMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_MESSAGES_LIST,
		listener: (msg: AiMessagesListMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_PROMPT,
		listener: (msg: AiPromptMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_ATTACHMENT_WRITE,
		listener: (msg: AiAttachmentWriteMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_SESSION_CONFIG_SET,
		listener: (msg: AiSessionConfigSetMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_SESSION_MODE_SET,
		listener: (msg: AiSessionModeSetMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_ABORT,
		listener: (msg: AiAbortMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_AGENTS_LIST,
		listener: (msg: AiAgentsListMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_AGENTS_MANAGE_LIST,
		listener: (msg: AiAgentsManageListMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_AGENTS_ENABLE_SET,
		listener: (msg: AiAgentsEnableSetMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_AGENTS_CUSTOM_ADD,
		listener: (msg: AiAgentsCustomAddMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_AGENTS_CUSTOM_UPDATE,
		listener: (msg: AiAgentsCustomUpdateMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_AGENTS_CUSTOM_REMOVE,
		listener: (msg: AiAgentsCustomRemoveMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_ACTIVITY_LIST,
		listener: (msg: AiActivityListMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_ACTIVITY_DISMISS,
		listener: (msg: AiActivityDismissMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_PROVIDERS_LIST,
		listener: (msg: AiProvidersListMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_AUTH_SET,
		listener: (msg: AiAuthSetMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_COMMAND,
		listener: (msg: AiCommandMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_REVERT,
		listener: (msg: AiRevertMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_UNREVERT,
		listener: (msg: AiUnrevertMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_SHARE,
		listener: (msg: AiShareMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_PERMISSION_REPLY,
		listener: (msg: AiPermissionReplyMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_QUESTION_REPLY,
		listener: (msg: AiQuestionReplyMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_QUESTION_REJECT,
		listener: (msg: AiQuestionRejectMsg) => void,
	): this;
	on(
		eventName: typeof MsgType.AI_QUESTION_REJECT,
		listener: (msg: AiQuestionRejectMsg) => void,
	): this;
	on(eventName: "disconnected", listener: (info: DisconnectInfo) => void): this;
	on<TArgs extends unknown[]>(
		eventName: string | symbol,
		listener: (...args: TArgs) => void,
	): this {
		return super.on(eventName, this.wrapListener(eventName, listener));
	}

	once(
		eventName: typeof MsgType.SESSION_HOSTED,
		listener: (msg: HostHandshakeMsg) => void,
	): this;
	once(
		eventName: typeof MsgType.SESSION_ERROR,
		listener: (msg: HostHandshakeMsg) => void,
	): this;
	once(
		eventName: typeof MsgType.SESSION_CLIENT_JOINED,
		listener: (msg: SessionClientJoinedMsg) => void,
	): this;
	once(
		eventName: typeof MsgType.SESSION_CLIENT_LEFT,
		listener: (msg: SessionClientLeftMsg) => void,
	): this;
	once(
		eventName: typeof MsgType.SESSION_CLIENT_JOIN,
		listener: (msg: SessionClientJoinMsg) => void,
	): this;
	once(
		eventName: typeof MsgType.SYSMON_GET,
		listener: (msg: SysmonGetMsg) => void,
	): this;
	once(
		eventName: typeof MsgType.TERMINAL_CREATE,
		listener: (msg: TerminalCreateMsg) => void,
	): this;
	once(
		eventName: typeof MsgType.TERMINAL_LIST,
		listener: (msg: TerminalListMsg) => void,
	): this;
	once(
		eventName: typeof MsgType.TERMINAL_ATTACH,
		listener: (msg: TerminalAttachMsg) => void,
	): this;
	once(
		eventName: typeof MsgType.TERMINAL_DATA,
		listener: (msg: TerminalDataMsg) => void,
	): this;
	once(
		eventName: typeof MsgType.TERMINAL_RESIZE,
		listener: (msg: TerminalResizeMsg) => void,
	): this;
	once(
		eventName: typeof MsgType.TERMINAL_CLOSE,
		listener: (msg: TerminalCloseMsg) => void,
	): this;
	once(
		eventName: typeof MsgType.FS_LIST,
		listener: (msg: FsListMsg) => void,
	): this;
	once(
		eventName: typeof MsgType.FS_READ,
		listener: (msg: FsReadMsg) => void,
	): this;
	once(
		eventName: typeof MsgType.FS_WRITE,
		listener: (msg: FsWriteMsg) => void,
	): this;
	once(
		eventName: typeof MsgType.FS_MKDIR,
		listener: (msg: FsMkdirMsg) => void,
	): this;
	once(
		eventName: typeof MsgType.FS_DELETE,
		listener: (msg: FsDeleteMsg) => void,
	): this;
	once(
		eventName: typeof MsgType.FS_RENAME,
		listener: (msg: FsRenameMsg) => void,
	): this;
	once(
		eventName: typeof MsgType.FS_STAT,
		listener: (msg: FsStatMsg) => void,
	): this;
	once(
		eventName: typeof MsgType.PROJECT_INFO,
		listener: (msg: ProjectInfoMsg) => void,
	): this;
	once(
		eventName: typeof MsgType.PROJECT_FILE_SEARCH,
		listener: (msg: ProjectFileSearchMsg) => void,
	): this;
	once(
		eventName: typeof MsgType.GIT_READ,
		listener: (msg: GitReadMsg) => void,
	): this;
	once(
		eventName: typeof MsgType.GIT_LOG,
		listener: (msg: GitLogMsg) => void,
	): this;
	once(
		eventName: typeof MsgType.GIT_COMMIT_FILES,
		listener: (msg: GitCommitFilesMsg) => void,
	): this;
	once(
		eventName: typeof MsgType.GIT_COMMIT_FILE_DIFF,
		listener: (msg: GitCommitFileDiffMsg) => void,
	): this;
	once(
		eventName: typeof MsgType.PORTS_LIST,
		listener: (msg: PortsListMsg) => void,
	): this;
	once(
		eventName: typeof MsgType.PORTS_KILL,
		listener: (msg: PortsKillMsg) => void,
	): this;
	once(
		eventName: typeof MsgType.HTTP_REQUEST,
		listener: (msg: HttpRequestMsg) => void,
	): this;
	once(
		eventName: typeof MsgType.WS_OPEN,
		listener: (msg: WsOpenMsg) => void,
	): this;
	once(
		eventName: typeof MsgType.WS_DATA,
		listener: (msg: WsDataMsg) => void,
	): this;
	once(
		eventName: typeof MsgType.WS_CLOSE,
		listener: (msg: WsCloseMsg) => void,
	): this;
	once(
		eventName: typeof MsgType.AI_AVAILABILITY,
		listener: (msg: AiAvailabilityMsg) => void,
	): this;
	once(
		eventName: "disconnected",
		listener: (info: DisconnectInfo) => void,
	): this;
	once<TArgs extends unknown[]>(
		eventName: string | symbol,
		listener: (...args: TArgs) => void,
	): this {
		return super.once(eventName, this.wrapListener(eventName, listener));
	}

	emit(
		eventName: typeof MsgType.SESSION_HOSTED,
		msg: HostHandshakeMsg,
	): boolean;
	emit(eventName: typeof MsgType.SESSION_ERROR, msg: SessionErrorMsg): boolean;
	emit(
		eventName: typeof MsgType.SESSION_CLIENT_JOINED,
		msg: SessionClientJoinedMsg,
	): boolean;
	emit(
		eventName: typeof MsgType.SESSION_CLIENT_LEFT,
		msg: SessionClientLeftMsg,
	): boolean;
	emit(
		eventName: typeof MsgType.SESSION_CLIENT_JOIN,
		msg: SessionClientJoinMsg,
	): boolean;
	emit(eventName: typeof MsgType.SYSMON_GET, msg: SysmonGetMsg): boolean;
	emit(
		eventName: typeof MsgType.TERMINAL_CREATE,
		msg: TerminalCreateMsg,
	): boolean;
	emit(eventName: typeof MsgType.TERMINAL_LIST, msg: TerminalListMsg): boolean;
	emit(
		eventName: typeof MsgType.TERMINAL_ATTACH,
		msg: TerminalAttachMsg,
	): boolean;
	emit(eventName: typeof MsgType.TERMINAL_DATA, msg: TerminalDataMsg): boolean;
	emit(
		eventName: typeof MsgType.TERMINAL_RESIZE,
		msg: TerminalResizeMsg,
	): boolean;
	emit(
		eventName: typeof MsgType.TERMINAL_CLOSE,
		msg: TerminalCloseMsg,
	): boolean;
	emit(eventName: typeof MsgType.FS_LIST, msg: FsListMsg): boolean;
	emit(eventName: typeof MsgType.FS_READ, msg: FsReadMsg): boolean;
	emit(eventName: typeof MsgType.FS_WRITE, msg: FsWriteMsg): boolean;
	emit(eventName: typeof MsgType.FS_MKDIR, msg: FsMkdirMsg): boolean;
	emit(eventName: typeof MsgType.FS_DELETE, msg: FsDeleteMsg): boolean;
	emit(eventName: typeof MsgType.FS_RENAME, msg: FsRenameMsg): boolean;
	emit(eventName: typeof MsgType.FS_STAT, msg: FsStatMsg): boolean;
	emit(eventName: typeof MsgType.PROJECT_INFO, msg: ProjectInfoMsg): boolean;
	emit(
		eventName: typeof MsgType.PROJECT_FILE_SEARCH,
		msg: ProjectFileSearchMsg,
	): boolean;
	emit(eventName: typeof MsgType.GIT_READ, msg: GitReadMsg): boolean;
	emit(eventName: typeof MsgType.GIT_LOG, msg: GitLogMsg): boolean;
	emit(
		eventName: typeof MsgType.GIT_COMMIT_FILES,
		msg: GitCommitFilesMsg,
	): boolean;
	emit(
		eventName: typeof MsgType.GIT_COMMIT_FILE_DIFF,
		msg: GitCommitFileDiffMsg,
	): boolean;
	emit(eventName: typeof MsgType.PORTS_LIST, msg: PortsListMsg): boolean;
	emit(eventName: typeof MsgType.PORTS_KILL, msg: PortsKillMsg): boolean;
	emit(eventName: typeof MsgType.HTTP_REQUEST, msg: HttpRequestMsg): boolean;
	emit(eventName: typeof MsgType.WS_OPEN, msg: WsOpenMsg): boolean;
	emit(eventName: typeof MsgType.WS_DATA, msg: WsDataMsg): boolean;
	emit(eventName: typeof MsgType.WS_CLOSE, msg: WsCloseMsg): boolean;
	emit(
		eventName: typeof MsgType.AI_AVAILABILITY,
		msg: AiAvailabilityMsg,
	): boolean;
	emit(
		eventName: typeof MsgType.AI_SESSION_LIST,
		msg: AiSessionListMsg,
	): boolean;
	emit(
		eventName: typeof MsgType.AI_SESSION_CREATE,
		msg: AiSessionCreateMsg,
	): boolean;
	emit(eventName: typeof MsgType.AI_SESSION_GET, msg: AiSessionGetMsg): boolean;
	emit(
		eventName: typeof MsgType.AI_SESSION_DELETE,
		msg: AiSessionDeleteMsg,
	): boolean;
	emit(
		eventName: typeof MsgType.AI_MESSAGES_LIST,
		msg: AiMessagesListMsg,
	): boolean;
	emit(eventName: typeof MsgType.AI_PROMPT, msg: AiPromptMsg): boolean;
	emit(
		eventName: typeof MsgType.AI_ATTACHMENT_WRITE,
		msg: AiAttachmentWriteMsg,
	): boolean;
	emit(eventName: typeof MsgType.AI_ABORT, msg: AiAbortMsg): boolean;
	emit(eventName: typeof MsgType.AI_AGENTS_LIST, msg: AiAgentsListMsg): boolean;
	emit(
		eventName: typeof MsgType.AI_ACTIVITY_LIST,
		msg: AiActivityListMsg,
	): boolean;
	emit(
		eventName: typeof MsgType.AI_ACTIVITY_DISMISS,
		msg: AiActivityDismissMsg,
	): boolean;
	emit(
		eventName: typeof MsgType.AI_PROVIDERS_LIST,
		msg: AiProvidersListMsg,
	): boolean;
	emit(eventName: typeof MsgType.AI_AUTH_SET, msg: AiAuthSetMsg): boolean;
	emit(eventName: typeof MsgType.AI_COMMAND, msg: AiCommandMsg): boolean;
	emit(eventName: typeof MsgType.AI_REVERT, msg: AiRevertMsg): boolean;
	emit(eventName: typeof MsgType.AI_UNREVERT, msg: AiUnrevertMsg): boolean;
	emit(eventName: typeof MsgType.AI_SHARE, msg: AiShareMsg): boolean;
	emit(
		eventName: typeof MsgType.AI_PERMISSION_REPLY,
		msg: AiPermissionReplyMsg,
	): boolean;
	emit(
		eventName: typeof MsgType.AI_QUESTION_REPLY,
		msg: AiQuestionReplyMsg,
	): boolean;
	emit(
		eventName: typeof MsgType.AI_QUESTION_REJECT,
		msg: AiQuestionRejectMsg,
	): boolean;
	emit(
		eventName: typeof MsgType.AI_QUESTION_REJECT,
		msg: AiQuestionRejectMsg,
	): boolean;
	emit(eventName: "disconnected", info: DisconnectInfo): boolean;
	emit<TArgs extends unknown[]>(
		eventName: string | symbol,
		...args: TArgs
	): boolean {
		return super.emit(eventName, ...args);
	}

	private handleIncomingMessage(raw: string) {
		const baseMsg = parseMessage(raw, BaseMsgSchema);
		if (!baseMsg.data) {
			logger.error("Received invalid message:", raw.slice(0, 100));
			return;
		}

		if (PLAINTEXT_TYPES.has(baseMsg.data.type)) {
			const msg = parseMessage(baseMsg.data, HostIncomingMsgSchema);
			if (!msg.data) {
				if (config.SHELLULAR_DEV) {
					logger.error(
						`Received invalid message of type ${baseMsg.data.type}:`,
						msg.error,
						JSON.stringify(baseMsg.data),
					);
				} else {
					logger.error(`Received invalid message of type ${baseMsg.data.type}`);
				}
				return;
			}

			return this.dispatchMessage(msg.data);
		} else if (baseMsg.data.type !== MsgType.ENCRYPTED) {
			if (config.SHELLULAR_DEV) {
				logger.error(
					`Received plain text message of type ${baseMsg.data.type}. Rejected for security.`,
					JSON.stringify(baseMsg.data),
				);
			} else {
				logger.error(
					`Received plain text message of type ${baseMsg.data.type}. Rejected for security.`,
				);
			}
			return;
		}

		// Try to parse as encrypted envelope first
		const encMsg = parseMessage(baseMsg.data, EncryptedMsgSchema);
		if (encMsg.data) {
			const plaintext = decrypt(encMsg.data.nonce, encMsg.data.ciphertext);
			if (!plaintext) {
				logger.error("Failed to decrypt a message");
				return;
			}

			const innerMsg = parseMessage(plaintext, HostIncomingMsgSchema);
			if (!innerMsg.data) {
				logger.error(
					`Decrypted message of type ${baseMsg.data.type} failed validation:`,
					plaintext,
					"\nerror",
					innerMsg.error,
				);
				return;
			}

			return this.dispatchMessage(innerMsg.data);
		}
	}

	private dispatchMessage(msg: HostIncomingMsg) {
		// Handle client joined/left events
		if (msg.type === MsgType.SESSION_CLIENT_JOINED) {
			this.clients.add(msg.data.clientId, msg.data);
		} else if (msg.type === MsgType.SESSION_CLIENT_LEFT) {
			this.clients.delete(msg.data.clientId);
		}

		// SAFETY: IncomingMsgSchema validated the message. The generic emit
		// avoids exhaustive overload matching on every MsgType variant.
		return super.emit(msg.type, msg) as boolean;
	}

	private wrapListener<TArgs extends unknown[]>(
		eventName: string | symbol,
		listener: (...args: TArgs) => void | Promise<void>,
	): (...args: TArgs) => void {
		return (...args: TArgs) => {
			try {
				const result = listener(...args);
				if (result instanceof Promise) {
					result.catch((err) => {
						this.logListenerError(eventName, err);
					});
				}
			} catch (err) {
				this.logListenerError(eventName, err);
			}
		};
	}

	private logListenerError(eventName: string | symbol, err: unknown) {
		logger.error(`Connection listener for ${String(eventName)} failed:`, err);
	}

	open() {
		return new Promise<void>((resolve, reject) => {
			// reject if connection fails
			this.ws.once("error", reject);

			// reject if connection closes before handshake completes
			this.ws.once("close", (code, reason) => {
				const errorMsgPieces = [
					"Closed before handshake completed.",
					`Code: ${code}`,
				];
				if (reason) {
					errorMsgPieces.push(`Reason: ${reason.toString()}`);
				}
				const errorMsg = errorMsgPieces.join(" ");
				logger.error(errorMsg);
				reject(new Error(errorMsg));
			});

			// init handshake on open
			this.ws.once("open", () => {
				const msg: SessionHostMsg = {
					type: MsgType.SESSION_HOST,
					data: this.hostInfo,
				};
				this.send(msg);
			});

			// now wait for handshake response and resolve/reject accordingly
			this.ws.once("message", (raw) => {
				this.ws.removeAllListeners("error");
				this.ws.removeAllListeners("close");

				const rawStr = raw.toString();
				const msg = parseMessage(rawStr, HostHandshakeRespMsgSchema);
				if (!msg.data) {
					logger.error("Received invalid handshake response:", rawStr);
					reject(new Error("Invalid handshake response"));
					return;
				}

				switch (msg.data.type) {
					case MsgType.SESSION_HOSTED:
						this.sessionId = msg.data.data.sessionId;
						resolve();

						this.ws.on("message", (nextRaw) => {
							this.handleIncomingMessage(nextRaw.toString());
						});

						this.ws.on("error", (err) => {
							logger.error(
								"WebSocket error:",
								err instanceof Error ? err.message : err,
							);
						});

						this.ws.on("close", (code, reason) => {
							this.stopHeartbeat();
							this.emit("disconnected", {
								code,
								reason: reason.toString(),
							});
						});

						this.startHeartbeat();
						return;

					case MsgType.SESSION_ERROR:
						reject(new Error(msg.error ?? "Handshake Error"));
						return;
				}
			});
		});
	}

	send<TType extends SendableMsg["type"]>(
		msg: Extract<SendableMsg, { type: TType }>,
	) {
		const id = `host_${nanoid()}`;
		const msgWithId = { id, ...msg } as OutgoingMsg;

		if (PLAINTEXT_TYPES.has(msg.type)) {
			this.ws.send(JSON.stringify(msgWithId));
		} else {
			const { nonce, ciphertext } = encrypt(JSON.stringify(msgWithId));

			// Expose clientId on the outer envelope so the relay server can route
			const clientId = "clientId" in msg ? msg.clientId : undefined;
			if (clientId && !this.clients.isConnected(clientId)) {
				logger.debug(
					`Not sending message of type ${msg.type} to client ${clientId} because it's NOT connected`,
				);
				return;
			}

			const encryptedMsg = clientId
				? {
						id,
						type: MsgType.ENCRYPTED,
						clientId,
						nonce,
						ciphertext,
					}
				: {
						id,
						type: MsgType.ENCRYPTED,
						nonce,
						ciphertext,
					};
			this.ws.send(JSON.stringify(encryptedMsg));
		}
	}

	sendBinary(data: Uint8Array | Buffer): boolean {
		if (this.ws.readyState !== WebSocket.OPEN) {
			return false;
		}

		try {
			this.ws.send(data, { binary: true });
			return true;
		} catch (err) {
			logger.error("Failed to send binary WebSocket frame:", err);
			return false;
		}
	}

	private startHeartbeat() {
		this.heartbeatTimer = setInterval(() => {
			if (this.ws.readyState === WebSocket.CONNECTING) {
				return;
			}

			try {
				this.send({ type: MsgType.PING });
			} catch {
				logger.log("Heartbeat failed — connection is dead");
				this.ws.terminate();
			}
		}, HEARTBEAT_INTERVAL_MS);
	}

	private stopHeartbeat() {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	close() {
		this.stopHeartbeat();
		this.ws.close();
	}
}

export async function connect(
	serverUrl: string,
	hostInfo: HostInfo,
): Promise<Connection> {
	const conn = new Connection(serverUrl, hostInfo);
	await conn.open();
	return conn;
}

const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000];

export function connectWithReconnect(
	serverUrl: string,
	hostInfo: HostInfo,
	onConnected: (conn: Connection, isFirst: boolean) => void,
): void {
	let closing = false;
	let currentConn: Connection | null = null;
	let isFirstConn = true;

	async function tryConnect() {
		let attempt = 0;
		while (!closing) {
			try {
				const conn = await connect(serverUrl, hostInfo);

				currentConn = conn;
				attempt = 0;

				conn.on("disconnected", (info) => {
					if (closing) {
						return;
					}

					logger.warn(
						`Connection lost (code: ${info.code}, reason: ${info.reason || "none"}). Reconnecting...`,
					);
					currentConn = null;
					tryConnect();
				});

				onConnected(conn, isFirstConn);
				if (isFirstConn) {
					isFirstConn = false;
				}

				return;
			} catch (err) {
				if (closing) {
					return;
				}

				const delay =
					RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
				logger.error(
					`Connection attempt ${attempt + 1} failed:`,
					err instanceof Error ? err.message : err,
				);
				logger.log(`Retrying in ${delay / 1000}s...`);
				await new Promise((r) => setTimeout(r, delay));
				attempt++;
			}
		}
	}

	tryConnect();

	// Handle graceful shutdown
	const shutdown = () => {
		closing = true;
		if (currentConn) {
			currentConn.close();
		}

		process.exit(0);
	};

	process.on("SIGINT", () => {
		shutdown();
		logger.log("Bye Bye Bye");
	});
	process.on("SIGTERM", shutdown);
}

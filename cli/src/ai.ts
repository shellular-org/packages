import type { AiManager } from "./ai/index";
import type { Connection } from "./connection";
import { logger } from "./logger";
import {
	type AiAbortMsg,
	type AiAgentsListMsg,
	type AiAuthSetMsg,
	type AiMessagesListMsg,
	type AiPermissionReplyMsg,
	type AiPromptMsg,
	type AiProvidersListMsg,
	type AiQuestionRejectMsg,
	type AiQuestionReplyMsg,
	type AiSession,
	type AiSessionCreateMsg,
	type AiSessionDeleteMsg,
	type AiSessionGetMsg,
	type AiSessionListMsg,
	MsgType,
} from "@shellular/protocol";

function getErrorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	return String(err);
}

export async function initAiHandler(conn: Connection, aiManager: AiManager) {
	aiManager.subscribe((clientId, backend, event) => {
		if (event.type === "server.heartbeat") {
			return;
		}

		if (typeof event.properties.sessionId !== "string") {
			return;
		}

		logger.debug("AI manager emitted event", { backend, type: event.type });
		conn.send({
			clientId,
			type: MsgType.AI_EVENT,
			data: {
				backend,
				...event,
				properties: {
					...event.properties,
					sessionId: event.properties.sessionId,
				},
			},
		});
		return;
	});

	conn.on(MsgType.AI_AVAILABILITY, (msg) => {
		const backends = aiManager.availableBackends();
		conn.send({
			type: MsgType.AI_AVAILABILITY_RESULT,
			clientId: msg.clientId,
			respTo: msg.id,
			data: { backends },
		});
	});

	conn.on(MsgType.AI_SESSION_LIST, async (msg: AiSessionListMsg) => {
		try {
			let sessions: AiSession[] = [];
			const backend = msg.data?.backend;
			if (backend) {
				sessions = await aiManager.listSessions(msg.clientId, backend);
			} else {
				sessions = await aiManager.listAllSessions(msg.clientId);
			}
			conn.send({
				type: MsgType.AI_SESSION_LIST_RESULT,
				clientId: msg.clientId,
				respTo: msg.id,
				data: { sessions },
			});
		} catch (err) {
			conn.send({
				type: MsgType.AI_SESSION_LIST_RESULT,
				clientId: msg.clientId,
				respTo: msg.id,
				error: getErrorMessage(err),
			});
		}
	});

	conn.on(MsgType.AI_SESSION_CREATE, async (msg: AiSessionCreateMsg) => {
		try {
			const session = await aiManager.createSession(
				msg.clientId,
				msg.data.backend,
				msg.data.prompt,
				msg.data.workspacePath,
			);
			conn.send({
				type: MsgType.AI_SESSION_CREATE_RESULT,
				clientId: msg.clientId,
				respTo: msg.id,
				data: { session },
			});
		} catch (err) {
			conn.send({
				type: MsgType.AI_SESSION_CREATE_RESULT,
				clientId: msg.clientId,
				respTo: msg.id,
				error: getErrorMessage(err),
			});
		}
	});

	conn.on(MsgType.AI_SESSION_GET, async (msg: AiSessionGetMsg) => {
		try {
			const session = await aiManager.getSession(
				msg.clientId,
				msg.data.backend,
				msg.data.sessionId,
			);
			conn.send({
				type: MsgType.AI_SESSION_GET_RESULT,
				clientId: msg.clientId,
				respTo: msg.id,
				data: { backend: msg.data.backend, session },
			});
		} catch (err) {
			conn.send({
				type: MsgType.AI_SESSION_GET_RESULT,
				clientId: msg.clientId,
				respTo: msg.id,
				error: getErrorMessage(err),
			});
		}
	});

	conn.on(MsgType.AI_SESSION_DELETE, async (msg: AiSessionDeleteMsg) => {
		try {
			const deleted = await aiManager.deleteSession(
				msg.clientId,
				msg.data.backend,
				msg.data.sessionId,
			);
			conn.send({
				type: MsgType.AI_SESSION_DELETED,
				clientId: msg.clientId,
				respTo: msg.id,
				data: { deleted },
			});
		} catch (err) {
			conn.send({
				type: MsgType.AI_SESSION_DELETED,
				clientId: msg.clientId,
				respTo: msg.id,
				error: getErrorMessage(err),
			});
		}
	});

	conn.on(MsgType.AI_MESSAGES_LIST, async (msg: AiMessagesListMsg) => {
		try {
			const messages = await aiManager.getMessages(
				msg.clientId,
				msg.data.backend,
				msg.data.sessionId,
			);
			conn.send({
				type: MsgType.AI_MESSAGES_LIST_RESULT,
				clientId: msg.clientId,
				respTo: msg.id,
				data: { backend: msg.data.backend, messages },
			});
		} catch (err) {
			conn.send({
				type: MsgType.AI_MESSAGES_LIST_RESULT,
				clientId: msg.clientId,
				respTo: msg.id,
				error: getErrorMessage(err),
			});
		}
	});

	conn.on(MsgType.AI_PROMPT, async (msg: AiPromptMsg) => {
		try {
			const { ack } = await aiManager.prompt(
				msg.clientId,
				msg.data.backend,
				msg.data.sessionId,
				msg.data.text,
				msg.data.model,
				msg.data.agent,
				msg.data.files,
				msg.data.codexOptions,
			);
			conn.send({
				type: MsgType.AI_PROMPT_ACK,
				clientId: msg.clientId,
				respTo: msg.id,
				data: { ack, backend: msg.data.backend, sessionId: msg.data.sessionId },
			});
		} catch (err) {
			conn.send({
				type: MsgType.AI_PROMPT_ACK,
				clientId: msg.clientId,
				respTo: msg.id,
				error: getErrorMessage(err),
			});
		}
	});

	conn.on(MsgType.AI_ABORT, async (msg: AiAbortMsg) => {
		try {
			await aiManager.abort(msg.clientId, msg.data.backend, msg.data.sessionId);
			conn.send({
				type: MsgType.AI_ABORT_ACK,
				clientId: msg.clientId,
				respTo: msg.id,
				data: { ok: true },
			});
		} catch (err) {
			conn.send({
				type: MsgType.AI_ABORT_ACK,
				clientId: msg.clientId,
				respTo: msg.id,
				error: getErrorMessage(err),
			});
		}
	});

	conn.on(MsgType.AI_AGENTS_LIST, async (msg: AiAgentsListMsg) => {
		try {
			const agents = await aiManager.agents(msg.clientId, msg.data?.backend);
			conn.send({
				type: MsgType.AI_AGENTS_LIST_RESULT,
				clientId: msg.clientId,
				respTo: msg.id,
				data: { agents },
			});
		} catch (err) {
			conn.send({
				type: MsgType.AI_AGENTS_LIST_RESULT,
				clientId: msg.clientId,
				respTo: msg.id,
				error: getErrorMessage(err),
			});
		}
	});

	conn.on(MsgType.AI_PROVIDERS_LIST, async (msg: AiProvidersListMsg) => {
		try {
			const providers = await aiManager.providers(
				msg.clientId,
				msg.data?.backend,
			);
			conn.send({
				type: MsgType.AI_PROVIDERS_LIST_RESULT,
				clientId: msg.clientId,
				respTo: msg.id,
				data: { providers },
			});
		} catch (err) {
			conn.send({
				type: MsgType.AI_PROVIDERS_LIST_RESULT,
				clientId: msg.clientId,
				respTo: msg.id,
				error: getErrorMessage(err),
			});
		}
	});

	conn.on(MsgType.AI_AUTH_SET, async (msg: AiAuthSetMsg) => {
		try {
			await aiManager.setAuth(
				msg.clientId,
				msg.data.backend,
				msg.data.providerId,
				msg.data.key,
			);
			conn.send({
				type: MsgType.AI_AUTH_SET_ACK,
				clientId: msg.clientId,
				respTo: msg.id,
				data: { ok: true },
			});
		} catch (err) {
			conn.send({
				type: MsgType.AI_AUTH_SET_ACK,
				clientId: msg.clientId,
				respTo: msg.id,
				error: getErrorMessage(err),
			});
		}
	});

	conn.on(MsgType.AI_PERMISSION_REPLY, async (msg: AiPermissionReplyMsg) => {
		try {
			await aiManager.permissionReply(
				msg.clientId,
				msg.data.backend,
				msg.data.sessionId,
				msg.data.permissionId,
				msg.data.response,
			);
			conn.send({
				type: MsgType.AI_PERMISSION_REPLY_ACK,
				clientId: msg.clientId,
				respTo: msg.id,
				data: { ok: true },
			});
		} catch (err) {
			conn.send({
				type: MsgType.AI_PERMISSION_REPLY_ACK,
				clientId: msg.clientId,
				respTo: msg.id,
				error: getErrorMessage(err),
			});
		}
	});

	conn.on(MsgType.AI_QUESTION_REPLY, async (msg: AiQuestionReplyMsg) => {
		try {
			await aiManager.questionReply(
				msg.clientId,
				msg.data.backend,
				msg.data.sessionId,
				msg.data.questionId,
				msg.data.answers,
			);
			conn.send({
				type: MsgType.AI_QUESTION_REPLY_ACK,
				clientId: msg.clientId,
				respTo: msg.id,
				data: { ok: true },
			});
		} catch (err) {
			conn.send({
				type: MsgType.AI_QUESTION_REPLY_ACK,
				clientId: msg.clientId,
				respTo: msg.id,
				error: getErrorMessage(err),
			});
		}
	});

	conn.on(MsgType.AI_QUESTION_REJECT, async (msg: AiQuestionRejectMsg) => {
		try {
			await aiManager.questionReject(
				msg.clientId,
				msg.data.backend,
				msg.data.sessionId,
				msg.data.questionId,
			);
			conn.send({
				type: MsgType.AI_QUESTION_REJECT_ACK,
				clientId: msg.clientId,
				respTo: msg.id,
				data: { ok: true },
			});
		} catch (err) {
			conn.send({
				type: MsgType.AI_QUESTION_REJECT_ACK,
				clientId: msg.clientId,
				respTo: msg.id,
				error: getErrorMessage(err),
			});
		}
	});
}

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type {
	AcpPromptRequest,
	AiAttachmentWriteMsg,
	AiAttachmentWriteResultMsg,
	AiBackend,
	AiEvent,
	AiSession,
	AiSessionCreateMsg,
} from "@shellular/protocol";
import { AcpContentBlockSchema, MsgType } from "@shellular/protocol";

import { config } from "@/config";
import type { Connection } from "@/connection";
import { BUILTIN_AGENT_DESCRIPTORS, isAgentAvailable } from "./agents";
import type { ACP } from "./base";
import { ClaudeCode } from "./claude-code";
import { Codex } from "./codex";
import { Copilot } from "./copilot";
import { Cursor } from "./cursor";
import { AgentUnavailableError } from "./errors";
import { Hermes } from "./hermes";
import { OpenCode } from "./opencode";
import { Pi } from "./pi";
import type { AgentDescriptor, AgentInfo } from "./types";

const MAX_AGENT_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function getErrorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	return String(err);
}

function safeAttachmentSegment(value: string) {
	return (
		value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown"
	);
}

function decodeBase64Attachment(content: string): Buffer {
	if (
		content.length % 4 === 1 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
			content,
		)
	) {
		throw new Error("Invalid attachment encoding");
	}
	const bytes = Buffer.from(content, "base64");
	if (bytes.length > MAX_AGENT_ATTACHMENT_BYTES) {
		throw new Error("Attachment is too large");
	}
	return bytes;
}

function nextAvailableAttachmentPath(dirPath: string, fileName: string) {
	const parsed = path.parse(fileName);
	for (let index = 0; index < 1000; index += 1) {
		const suffix = index === 0 ? "" : `-${index}`;
		const candidate = path.join(
			dirPath,
			`${parsed.name}${suffix}${parsed.ext}`,
		);
		if (!existsSync(candidate)) return candidate;
	}
	throw new Error("Unable to allocate attachment path");
}

function writeAgentAttachment(msg: AiAttachmentWriteMsg) {
	if (!msg.data.mimeType?.startsWith("image/")) {
		throw new Error("Only image attachments are supported");
	}
	const agent = safeAttachmentSegment(msg.data.backend);
	const session = safeAttachmentSegment(msg.data.sessionId);
	const fileName = safeAttachmentSegment(path.basename(msg.data.name));
	const dirPath = path.join(
		config.SHELLULAR_DIR,
		agent,
		session,
		"chat-attachments",
	);
	const bytes = decodeBase64Attachment(msg.data.content);
	mkdirSync(dirPath, { recursive: true });
	const filePath = nextAvailableAttachmentPath(dirPath, fileName);
	writeFileSync(filePath, bytes, { flag: "wx" });
	return {
		path: filePath,
		name: path.basename(filePath),
		size: bytes.length,
		mimeType: msg.data.mimeType,
	};
}

function eventClientId(event: AiEvent, fallbackClientId: string): string {
	const value = event.properties.clientId;
	return typeof value === "string" ? value : fallbackClientId;
}

export class AgentsManager {
	private descriptors = new Map<string, AgentDescriptor>();
	private agents = new Map<string, ACP>();
	private sessionAgents = new Map<string, string>();

	constructor() {
		for (const agent of Object.values(BUILTIN_AGENT_DESCRIPTORS)) {
			if (agent.disabled) {
				continue;
			}

			this.descriptors.set(agent.id, agent);
		}
	}

	listAgents() {
		return [...this.descriptors.values()].map((descriptor) => {
			const runtime = this.agents.get(descriptor.id);
			return (
				runtime?.getInfo() ?? {
					state: "exited",
					id: descriptor.id,
					name: descriptor.name,
					title: descriptor.title,
					version: descriptor.version,
					description: descriptor.description,
					available: isAgentAvailable(descriptor),
					installationCommands: descriptor.installationCommands,
				}
			);
		}) satisfies AgentInfo[];
	}

	notifyClient(clientId: string) {
		for (const [agentId, agent] of this.agents.entries()) {
			this.registerPermissionListener(agentId, clientId, agent);
			agent.requestPendingPermissions(clientId);
		}
	}

	async connectAgent(clientId: string, agentId: AiBackend) {
		const descriptor = this.descriptors.get(agentId);
		if (!descriptor) {
			throw new AgentUnavailableError(agentId, "unknown agent");
		}

		let agent = this.agents.get(agentId);
		if (!agent) {
			agent = createAgentRuntime(agentId);
			this.agents.set(agentId, agent);
			agent.onSessionUpdate((notification) => {
				const backend = descriptor.id;
				const clientId =
					this.sessionClientIds.get(
						this.sessionKey(descriptor.id, notification.sessionId),
					) ?? "";
				if (!clientId) return;
				const status = sessionStatusEvent(notification);
				if (status) this.emit(clientId, backend, status);
			});
		}

		this.registerPermissionListener(agentId, clientId, agent);
		await agent.init();
		return agent;
	}

	async listSessions(
		clientId: string,
		agentId: AiBackend,
		cwd?: string,
		cursor?: string,
	): Promise<{ sessions: AiSession[]; nextCursor?: string }> {
		const agent = await this.connectAgent(clientId, agentId);
		return agent.listAiSessionsPage(cwd, cursor);
	}

	async createSession(
		clientId: string,
		agentId: AiBackend,
		cwd: string,
		options: Parameters<ACP["createSession"]>[1] = {},
	) {
		const agent = await this.connectAgent(clientId, agentId);
		const result = await agent.createSession(cwd, options);
		this.sessionAgents.set(
			result.session.id ?? result.response.sessionId,
			agentId,
		);
		return result;
	}

	async loadSession(
		clientId: string,
		agentId: AiBackend,
		sessionId: string,
		cwd: string,
		options: Partial<
			Omit<Parameters<ACP["loadSession"]>[0], "sessionId" | "cwd">
		> = {},
	) {
		const agent = await this.connectAgent(clientId, agentId);
		this.rememberSessionClient(agentId, sessionId, clientId);
		return agent.loadSession(
			{
				...options,
				sessionId,
				cwd,
				mcpServers: options.mcpServers ?? [],
			},
			clientId,
		);
	}

	async resumeSession(
		clientId: string,
		agentId: AiBackend,
		sessionId: string,
		cwd: string,
		options: Partial<
			Omit<Parameters<ACP["resumeSession"]>[0], "sessionId" | "cwd">
		> = {},
	) {
		const agent = await this.connectAgent(clientId, agentId);
		this.rememberSessionClient(agentId, sessionId, clientId);
		return agent.resumeSession({
			...options,
			sessionId,
			cwd,
			mcpServers: options.mcpServers ?? [],
		});
	}

	async forkSession(
		clientId: string,
		agentId: AiBackend,
		sessionId: string,
		cwd: string,
		options: Partial<
			Omit<Parameters<ACP["forkSession"]>[0], "sessionId" | "cwd">
		> = {},
	) {
		const agent = await this.connectAgent(clientId, agentId);
		const result = await agent.forkSession({
			...options,
			sessionId,
			cwd,
			mcpServers: options.mcpServers ?? [],
		});
		if (result.session.id) this.sessionAgents.set(result.session.id, agentId);
		return result;
	}

	async closeSession(clientId: string, agentId: AiBackend, sessionId: string) {
		const agent = await this.connectAgent(clientId, agentId);
		const response = await agent.closeSession({ sessionId });
		this.sessionAgents.delete(sessionId);
		return response;
	}

	async prompt(
		clientId: string,
		agentId: AiBackend,
		sessionId: string,
		content: string | unknown[],
	) {
		const agent = await this.connectAgent(clientId, agentId);
		this.rememberSessionClient(agentId, sessionId, clientId);
		const prompt = normalizePromptContent(content);
		return agent.prompt(
			{
				sessionId,
				prompt,
			},
			{
				onEvent: (event) => {
					this.emit(eventClientId(event, clientId), agent.descriptor.id, event);
				},
			},
			clientId,
		);
	}

	async cancel(clientId: string, agentId: AiBackend, sessionId: string) {
		const agent = await this.connectAgent(clientId, agentId);
		return agent.interrupt({ sessionId });
	}

	async replyPermission(
		clientId: string,
		agentId: AiBackend,
		_sessionId: string,
		permissionId: string,
		optionId: string | undefined,
	) {
		if (!optionId) {
			throw new Error("ACP permission reply requires an optionId");
		}
		const agent = await this.connectAgent(clientId, agentId);
		return agent.replyPermission(permissionId, optionId);
	}

	async setSessionConfigOption(
		clientId: string,
		agentId: AiBackend,
		sessionId: string,
		configId: string,
		value: string | boolean,
	) {
		const agent = await this.connectAgent(clientId, agentId);
		return agent.setSessionConfigOption({
			sessionId,
			configId,
			...(typeof value === "boolean" ? { type: "boolean", value } : { value }),
		});
	}

	async setSessionMode(
		clientId: string,
		agentId: AiBackend,
		sessionId: string,
		modeId: string,
	) {
		const agent = await this.connectAgent(clientId, agentId);
		return agent.setSessionMode({ sessionId, modeId });
	}

	async setSessionModel(
		clientId: string,
		agentId: AiBackend,
		sessionId: string,
		modelId: string,
	) {
		const agent = await this.connectAgent(clientId, agentId);
		return agent.setSessionModel({ sessionId, modelId });
	}

	destroy() {
		for (const agent of this.agents.values()) {
			agent.destroy();
		}
		this.agents.clear();
		this.sessionAgents.clear();
	}

	getAvailableAgents(): AiBackend[] {
		return Object.values(BUILTIN_AGENT_DESCRIPTORS).flatMap((descriptor) =>
			descriptor.id && isAgentAvailable(descriptor) ? [descriptor.id] : [],
		);
	}

	private subscribers = new Set<
		(clientId: string, backend: AiBackend, event: AiEvent) => void
	>();
	private sessionClientIds = new Map<string, string>();
	private permissionListenerCleanups = new Map<string, () => void>();

	subscribe(
		emitter: (clientId: string, backend: AiBackend, event: AiEvent) => void,
	): () => void {
		this.subscribers.add(emitter);
		return () => this.subscribers.delete(emitter);
	}

	handleConnection(conn: Connection) {
		// This adapter keeps the current app protocol stable while the internals
		// move to ACP. Future UI work can consume listAgents/connectAgent directly.
		const unsubscribe = this.subscribe((clientId, backend, event) => {
			if (!clientId) return;
			if (typeof event.properties.sessionId !== "string") return;
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
		});

		conn.on(MsgType.AI_AVAILABILITY, (msg) => {
			conn.send({
				type: MsgType.AI_AVAILABILITY_RESULT,
				clientId: msg.clientId,
				respTo: msg.id,
				data: { backends: this.getAvailableAgents() },
			});
		});

		conn.on(MsgType.AI_SESSION_LIST, async (msg) => {
			try {
				const backend = msg.data?.backend;
				const workspace = (msg.data as { workspace?: string } | undefined)
					?.workspace;
				const cursor = (msg.data as { cursor?: string } | undefined)?.cursor;
				const result = backend
					? await this.listSessions(msg.clientId, backend, workspace, cursor)
					: {
							sessions: await this.listAllBuiltinSessions(
								msg.clientId,
								workspace,
							),
						};
				conn.send({
					type: MsgType.AI_SESSION_LIST_RESULT,
					clientId: msg.clientId,
					respTo: msg.id,
					data: result,
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

		conn.on(MsgType.AI_AGENTS_LIST, (msg) => {
			const agents = this.listAgents().filter(
				(agent) => !msg.data?.backend || agent.backend === msg.data.backend,
			);
			conn.send({
				type: MsgType.AI_AGENTS_LIST_RESULT,
				clientId: msg.clientId,
				respTo: msg.id,
				data: { agents },
			});
		});

		conn.on(MsgType.AI_SESSION_CREATE, async (msg: AiSessionCreateMsg) => {
			try {
				const { session, response, updates } = await this.createSession(
					msg.clientId,
					msg.data.backend,
					msg.data.cwd ?? msg.data.workspacePath,
					{
						additionalDirectories: msg.data.additionalDirectories,
						mcpServers: msg.data.mcpServers as never,
					},
				);
				if (session.id) {
					this.rememberSessionClient(
						msg.data.backend,
						session.id,
						msg.clientId,
					);
				}
				conn.send({
					type: MsgType.AI_SESSION_CREATE_RESULT,
					clientId: msg.clientId,
					respTo: msg.id,
					data: {
						session: {
							...session,
							configOptions: response.configOptions ?? undefined,
						} as typeof session,
						state: {
							availableCommands: latestAvailableCommands(updates),
							configOptions: response.configOptions ?? undefined,
							models: response.models,
							modes: response.modes,
						},
					},
				});
				if (session.id && msg.data.prompt.trim()) {
					void this.prompt(
						msg.clientId,
						msg.data.backend,
						session.id,
						msg.data.content ?? msg.data.prompt,
					).catch((err) => {
						this.emit(msg.clientId, msg.data.backend, {
							type: "error",
							properties: {
								sessionId: session.id,
								error: getErrorMessage(err),
							},
						});
					});
				}
			} catch (err) {
				conn.send({
					type: MsgType.AI_SESSION_CREATE_RESULT,
					clientId: msg.clientId,
					respTo: msg.id,
					error: getErrorMessage(err),
				});
			}
		});

		conn.on(MsgType.AI_SESSION_LOAD, async (msg) => {
			try {
				const result = await this.loadSession(
					msg.clientId,
					msg.data.backend,
					msg.data.sessionId,
					msg.data.cwd,
					{
						additionalDirectories: msg.data.additionalDirectories,
						mcpServers: msg.data.mcpServers as never,
					},
				);
				const agent = await this.connectAgent(msg.clientId, msg.data.backend);
				const session = agent.getSession(msg.data.sessionId) ?? {
					id: msg.data.sessionId,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					workspacePath: msg.data.cwd,
					configOptions: result.response.configOptions ?? undefined,
				};
				this.rememberSessionClient(
					msg.data.backend,
					msg.data.sessionId,
					msg.clientId,
				);
				conn.send({
					type: MsgType.AI_SESSION_LOAD_RESULT,
					clientId: msg.clientId,
					respTo: msg.id,
					data: {
						backend: msg.data.backend,
						session,
						state: {
							configOptions: result.response.configOptions ?? undefined,
							models: result.response.models,
							modes: result.response.modes,
						},
						messages: result.messages,
						updates: result.updates,
					},
				});
			} catch (err) {
				conn.send({
					type: MsgType.AI_SESSION_LOAD_RESULT,
					clientId: msg.clientId,
					respTo: msg.id,
					error: getErrorMessage(err),
				});
			}
		});

		conn.on(MsgType.AI_SESSION_RESUME, async (msg) => {
			try {
				const result = await this.resumeSession(
					msg.clientId,
					msg.data.backend,
					msg.data.sessionId,
					msg.data.cwd,
					{
						additionalDirectories: msg.data.additionalDirectories,
						mcpServers: msg.data.mcpServers as never,
					},
				);
				this.rememberSessionClient(
					msg.data.backend,
					msg.data.sessionId,
					msg.clientId,
				);
				conn.send({
					type: MsgType.AI_SESSION_RESUME_RESULT,
					clientId: msg.clientId,
					respTo: msg.id,
					data: {
						backend: msg.data.backend,
						session: result.session,
						state: {
							configOptions: result.response.configOptions ?? undefined,
							models: result.response.models,
							modes: result.response.modes,
						},
					},
				});
			} catch (err) {
				conn.send({
					type: MsgType.AI_SESSION_RESUME_RESULT,
					clientId: msg.clientId,
					respTo: msg.id,
					error: getErrorMessage(err),
				});
			}
		});

		conn.on(MsgType.AI_SESSION_FORK, async (msg) => {
			try {
				const result = await this.forkSession(
					msg.clientId,
					msg.data.backend,
					msg.data.sessionId,
					msg.data.cwd,
					{
						additionalDirectories: msg.data.additionalDirectories,
						mcpServers: msg.data.mcpServers as never,
					},
				);
				if (result.session.id) {
					this.rememberSessionClient(
						msg.data.backend,
						result.session.id,
						msg.clientId,
					);
				}
				conn.send({
					type: MsgType.AI_SESSION_FORK_RESULT,
					clientId: msg.clientId,
					respTo: msg.id,
					data: {
						backend: msg.data.backend,
						session: result.session,
						state: {
							configOptions: result.response.configOptions ?? undefined,
							models: result.response.models,
							modes: result.response.modes,
						},
					},
				});
			} catch (err) {
				conn.send({
					type: MsgType.AI_SESSION_FORK_RESULT,
					clientId: msg.clientId,
					respTo: msg.id,
					error: getErrorMessage(err),
				});
			}
		});

		conn.on(MsgType.AI_SESSION_CLOSE, async (msg) => {
			try {
				await this.closeSession(
					msg.clientId,
					msg.data.backend,
					msg.data.sessionId,
				);
				conn.send({
					type: MsgType.AI_SESSION_CLOSE_RESULT,
					clientId: msg.clientId,
					respTo: msg.id,
					data: {
						backend: msg.data.backend,
						sessionId: msg.data.sessionId,
						ok: true,
					},
				});
			} catch (err) {
				conn.send({
					type: MsgType.AI_SESSION_CLOSE_RESULT,
					clientId: msg.clientId,
					respTo: msg.id,
					error: getErrorMessage(err),
				});
			}
		});

		conn.on(MsgType.AI_SESSION_GET, async (msg) => {
			try {
				const agent = await this.connectAgent(msg.clientId, msg.data.backend);
				const session = agent.getSession(msg.data.sessionId);
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

		conn.on(MsgType.AI_MESSAGES_LIST, async (msg) => {
			try {
				const agent = await this.connectAgent(msg.clientId, msg.data.backend);
				conn.send({
					type: MsgType.AI_MESSAGES_LIST_RESULT,
					clientId: msg.clientId,
					respTo: msg.id,
					data: {
						backend: msg.data.backend,
						messages: agent.getMessages(msg.data.sessionId),
					},
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

		conn.on(MsgType.AI_PROMPT, async (msg) => {
			try {
				this.rememberSessionClient(
					msg.data.backend,
					msg.data.sessionId,
					msg.clientId,
				);
				void this.prompt(
					msg.clientId,
					msg.data.backend,
					msg.data.sessionId,
					msg.data.content ?? msg.data.text,
				);
				conn.send({
					type: MsgType.AI_PROMPT_ACK,
					clientId: msg.clientId,
					respTo: msg.id,
					data: {
						ack: true,
						backend: msg.data.backend,
						sessionId: msg.data.sessionId,
					},
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

		conn.on(MsgType.AI_ATTACHMENT_WRITE, async (msg: AiAttachmentWriteMsg) => {
			try {
				const attachment = writeAgentAttachment(msg);
				const respMsg: AiAttachmentWriteResultMsg = {
					type: MsgType.AI_ATTACHMENT_WRITE_RESULT,
					clientId: msg.clientId,
					respTo: msg.id,
					data: {
						backend: msg.data.backend,
						sessionId: msg.data.sessionId,
						...attachment,
					},
				};
				conn.send(respMsg);
			} catch (err) {
				const respMsg: AiAttachmentWriteResultMsg = {
					type: MsgType.AI_ATTACHMENT_WRITE_RESULT,
					clientId: msg.clientId,
					respTo: msg.id,
					error: getErrorMessage(err),
				};
				conn.send(respMsg);
			}
		});

		conn.on(MsgType.AI_SESSION_CONFIG_SET, async (msg) => {
			try {
				const response = await this.setSessionConfigOption(
					msg.clientId,
					msg.data.backend,
					msg.data.sessionId,
					msg.data.configId,
					msg.data.value,
				);
				conn.send({
					type: MsgType.AI_SESSION_CONFIG_SET_RESULT,
					clientId: msg.clientId,
					respTo: msg.id,
					data: {
						backend: msg.data.backend,
						sessionId: msg.data.sessionId,
						configOptions: response.configOptions,
					},
				});
				this.emit(msg.clientId, msg.data.backend, {
					type: "session.status",
					properties: {
						sessionId: msg.data.sessionId,
						status: {
							sessionUpdate: "config_option_update",
							configOptions: response.configOptions,
						},
						configOptions: response.configOptions,
					},
				});
			} catch (err) {
				conn.send({
					type: MsgType.AI_SESSION_CONFIG_SET_RESULT,
					clientId: msg.clientId,
					respTo: msg.id,
					error: getErrorMessage(err),
				});
			}
		});

		conn.on(MsgType.AI_SESSION_MODE_SET, async (msg) => {
			try {
				await this.setSessionMode(
					msg.clientId,
					msg.data.backend,
					msg.data.sessionId,
					msg.data.modeId,
				);
				conn.send({
					type: MsgType.AI_SESSION_MODE_SET_RESULT,
					clientId: msg.clientId,
					respTo: msg.id,
					data: {
						backend: msg.data.backend,
						sessionId: msg.data.sessionId,
						modeId: msg.data.modeId,
						ok: true,
					},
				});
			} catch (err) {
				conn.send({
					type: MsgType.AI_SESSION_MODE_SET_RESULT,
					clientId: msg.clientId,
					respTo: msg.id,
					error: getErrorMessage(err),
				});
			}
		});

		conn.on(MsgType.AI_SESSION_MODEL_SET, async (msg) => {
			try {
				await this.setSessionModel(
					msg.clientId,
					msg.data.backend,
					msg.data.sessionId,
					msg.data.modelId,
				);
				conn.send({
					type: MsgType.AI_SESSION_MODEL_SET_RESULT,
					clientId: msg.clientId,
					respTo: msg.id,
					data: {
						backend: msg.data.backend,
						sessionId: msg.data.sessionId,
						modelId: msg.data.modelId,
						ok: true,
					},
				});
			} catch (err) {
				conn.send({
					type: MsgType.AI_SESSION_MODEL_SET_RESULT,
					clientId: msg.clientId,
					respTo: msg.id,
					error: getErrorMessage(err),
				});
			}
		});

		conn.on(MsgType.AI_ABORT, async (msg) => {
			try {
				await this.cancel(msg.clientId, msg.data.backend, msg.data.sessionId);
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

		conn.on(MsgType.AI_PERMISSION_REPLY, async (msg) => {
			try {
				await this.replyPermission(
					msg.clientId,
					msg.data.backend,
					msg.data.sessionId,
					msg.data.permissionId,
					"optionId" in msg.data ? msg.data.optionId : undefined,
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

		conn.on(MsgType.SESSION_CLIENT_LEFT, (msg) => {
			this.removeClientPermissionListeners(msg.data.clientId);
		});

		conn.on("disconnected", () => {
			unsubscribe();
			this.removeAllPermissionListeners();
		});
	}

	private async listAllBuiltinSessions(
		clientId: string,
		workspace?: string,
	): Promise<AiSession[]> {
		const results = await Promise.allSettled(
			Object.values(BUILTIN_AGENT_DESCRIPTORS).flatMap((descriptor) =>
				descriptor.id
					? [
							this.connectAgent(clientId, descriptor.id).then((agent) =>
								agent.listAiSessions(workspace),
							),
						]
					: [],
			),
		);
		return results
			.flatMap((result) => (result.status === "fulfilled" ? result.value : []))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	private emit(clientId: string, backend: AiBackend, event: AiEvent) {
		for (const subscriber of this.subscribers) {
			subscriber(clientId, backend, event);
		}
	}

	private sessionKey(agentId: string, sessionId: string) {
		return `${agentId}:${sessionId}`;
	}

	private permissionListenerKey(agentId: string, clientId: string) {
		return `${agentId}:${clientId}`;
	}

	private registerPermissionListener(
		agentId: string,
		clientId: string,
		agent: ACP,
	) {
		const key = this.permissionListenerKey(agentId, clientId);
		if (this.permissionListenerCleanups.has(key)) return;
		const descriptor = this.descriptors.get(agentId);
		if (!descriptor) return;

		// ACP permission requests are client-side JSON-RPC calls. Convert them
		// into the existing Shellular event stream so the mobile app can decide.
		const cleanup = agent.onPermission(clientId, (permission) => {
			const targetClientId = this.sessionClientIds.get(
				this.sessionKey(agentId, permission.sessionId),
			);
			if (targetClientId !== clientId) return;
			this.emit(targetClientId, descriptor.id, {
				type: "permission.updated",
				properties: {
					id: permission.id,
					sessionId: permission.sessionId,
					callId: permission.toolCall.toolCallId,
					kind: permission.toolCall.kind ?? "other",
					title: permission.toolCall.title ?? "Permission requested",
					options: permission.options,
					metadata: permission.raw,
				},
			});
		});
		this.permissionListenerCleanups.set(key, cleanup);
	}

	private removeClientPermissionListeners(clientId: string) {
		for (const agentId of this.agents.keys()) {
			const key = this.permissionListenerKey(agentId, clientId);
			const cleanup = this.permissionListenerCleanups.get(key);
			if (!cleanup) continue;
			cleanup();
			this.permissionListenerCleanups.delete(key);
		}
	}

	private removeAllPermissionListeners() {
		for (const cleanup of this.permissionListenerCleanups.values()) {
			cleanup();
		}
		this.permissionListenerCleanups.clear();
	}

	private rememberSessionClient(
		agentId: string,
		sessionId: string,
		clientId: string,
	) {
		this.sessionClientIds.set(this.sessionKey(agentId, sessionId), clientId);
		this.sessionAgents.set(sessionId, agentId);
	}
}

export type { AgentDescriptor, AgentInfo };

function normalizePromptContent(
	content: string | unknown[],
): AcpPromptRequest["prompt"] {
	if (typeof content === "string") return [{ type: "text", text: content }];

	const parsed = content.flatMap((block) => {
		const result = AcpContentBlockSchema.safeParse(block);
		return result.success ? [result.data] : [];
	});

	return parsed.length ? parsed : [{ type: "text", text: "" }];
}

function createAgentRuntime(agentId: AiBackend): ACP {
	switch (agentId) {
		case "codex":
			return Codex.create();
		case "claude-code":
			return ClaudeCode.create();
		case "copilot":
			return Copilot.create();
		case "opencode":
			return OpenCode.create();
		case "pi":
			return Pi.create();
		case "cursor":
			return Cursor.create();
		case "hermes":
			return Hermes.create();
		default:
			throw new AgentUnavailableError(agentId, "unknown agent");
	}
}

function latestAvailableCommands(updates: unknown[]) {
	for (let index = updates.length - 1; index >= 0; index -= 1) {
		const update = (updates[index] as { update?: unknown }).update as
			| { sessionUpdate?: unknown; availableCommands?: unknown }
			| undefined;
		if (
			update?.sessionUpdate === "available_commands_update" &&
			Array.isArray(update.availableCommands)
		) {
			return update.availableCommands;
		}
	}
	return undefined;
}

function sessionStatusEvent(
	notification: acp.SessionNotification,
): AiEvent | null {
	const update = notification.update;
	switch (update.sessionUpdate) {
		case "available_commands_update":
			return {
				type: "session.status",
				properties: {
					sessionId: notification.sessionId,
					status: update,
					availableCommands: update.availableCommands,
				},
			};
		case "config_option_update":
			return {
				type: "session.status",
				properties: {
					sessionId: notification.sessionId,
					status: update,
					configOptions: update.configOptions,
				},
			};
		case "current_mode_update":
		case "session_info_update":
		case "usage_update":
			return {
				type: "session.status",
				properties: {
					sessionId: notification.sessionId,
					status: update,
				},
			};
		default:
			return null;
	}
}

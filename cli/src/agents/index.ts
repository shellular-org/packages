import type * as acp from "@agentclientprotocol/sdk";
import type {
	AcpPromptRequest,
	AiBackend,
	AiEvent,
	AiSession,
	AiSessionCreateMsg,
} from "@shellular/protocol";
import { AcpContentBlockSchema, MsgType } from "@shellular/protocol";

import type { Connection } from "@/connection";
import { BUILTIN_AGENT_DESCRIPTORS, isAgentAvailable } from "./agents";
import type { ACP } from "./base";
import { ClaudeCode } from "./claude-code";
import { Codex } from "./codex";
import { Copilot } from "./copilot";
import { Cursor } from "./cursor";
import { AgentUnavailableError } from "./errors";
import { OpenCode } from "./opencode";
import { Pi } from "./pi";
import type { AgentDescriptor, AgentInfo } from "./types";

function getErrorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	return String(err);
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
			const available = isAgentAvailable(descriptor);
			return (
				runtime?.getInfo() ?? {
					id: descriptor.id,
					backend: descriptor.id,
					name: descriptor.name,
					title: descriptor.title,
					version: descriptor.version,
					description: descriptor.description,
					icon: descriptor.icon,
					source: descriptor.source,
					state: available ? "exited" : "unavailable",
					available,
				}
			);
		}) satisfies AgentInfo[];
	}

	async connectAgent(agentId: AiBackend) {
		let agent = this.agents.get(agentId);
		if (!agent) {
			const descriptor = this.descriptors.get(agentId);
			if (!descriptor) {
				throw new AgentUnavailableError(agentId, "unknown agent");
			}

			agent = createAgentRuntime(agentId);
			this.agents.set(agentId, agent);
			// ACP permission requests are client-side JSON-RPC calls. Convert them
			// into the existing Shellular event stream so the mobile app can decide.
			agent.onPermission((permission) => {
				const backend = descriptor.id;
				const clientId =
					this.sessionClientIds.get(
						this.sessionKey(agentId, permission.sessionId),
					) ?? "";
				this.emit(clientId, backend, {
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
		await agent.init();
		return agent;
	}

	async listSessions(agentId: AiBackend, cwd?: string): Promise<AiSession[]> {
		const agent = await this.connectAgent(agentId);
		return agent.listAiSessions(cwd);
	}

	async createSession(
		agentId: AiBackend,
		cwd: string,
		options: Parameters<ACP["createSession"]>[1] = {},
	) {
		const agent = await this.connectAgent(agentId);
		const result = await agent.createSession(cwd, options);
		this.sessionAgents.set(
			result.session.id ?? result.response.sessionId,
			agentId,
		);
		return result;
	}

	async loadSession(
		agentId: AiBackend,
		sessionId: string,
		cwd: string,
		options: Partial<
			Omit<Parameters<ACP["loadSession"]>[0], "sessionId" | "cwd">
		> = {},
	) {
		const agent = await this.connectAgent(agentId);
		this.sessionAgents.set(sessionId, agentId);
		return agent.loadSession({
			...options,
			sessionId,
			cwd,
			mcpServers: options.mcpServers ?? [],
		});
	}

	async resumeSession(
		agentId: AiBackend,
		sessionId: string,
		cwd: string,
		options: Partial<
			Omit<Parameters<ACP["resumeSession"]>[0], "sessionId" | "cwd">
		> = {},
	) {
		const agent = await this.connectAgent(agentId);
		this.sessionAgents.set(sessionId, agentId);
		return agent.resumeSession({
			...options,
			sessionId,
			cwd,
			mcpServers: options.mcpServers ?? [],
		});
	}

	async forkSession(
		agentId: AiBackend,
		sessionId: string,
		cwd: string,
		options: Partial<
			Omit<Parameters<ACP["forkSession"]>[0], "sessionId" | "cwd">
		> = {},
	) {
		const agent = await this.connectAgent(agentId);
		const result = await agent.forkSession({
			...options,
			sessionId,
			cwd,
			mcpServers: options.mcpServers ?? [],
		});
		if (result.session.id) this.sessionAgents.set(result.session.id, agentId);
		return result;
	}

	async closeSession(agentId: AiBackend, sessionId: string) {
		const agent = await this.connectAgent(agentId);
		const response = await agent.closeSession({ sessionId });
		this.sessionAgents.delete(sessionId);
		return response;
	}

	async prompt(
		agentId: AiBackend,
		clientId: string,
		sessionId: string,
		content: string | unknown[],
	) {
		const agent = await this.connectAgent(agentId);
		this.rememberSessionClient(agentId, sessionId, clientId);
		const prompt = normalizePromptContent(content);
		return agent.prompt(
			{
				sessionId,
				prompt,
			},
			{
				onEvent: (event) =>
					this.emit(eventClientId(event, clientId), agent.descriptor.id, event),
			},
		);
	}

	async cancel(agentId: AiBackend, sessionId: string) {
		const agent = await this.connectAgent(agentId);
		return agent.interrupt({ sessionId });
	}

	async replyPermission(
		agentId: AiBackend,
		_sessionId: string,
		permissionId: string,
		optionId: string | undefined,
	) {
		if (!optionId) {
			throw new Error("ACP permission reply requires an optionId");
		}
		const agent = await this.connectAgent(agentId);
		return agent.replyPermission(permissionId, optionId);
	}

	async setSessionConfigOption(
		agentId: AiBackend,
		sessionId: string,
		configId: string,
		value: string | boolean,
	) {
		const agent = await this.connectAgent(agentId);
		return agent.setSessionConfigOption({
			sessionId,
			configId,
			...(typeof value === "boolean" ? { type: "boolean", value } : { value }),
		});
	}

	async setSessionMode(agentId: AiBackend, sessionId: string, modeId: string) {
		const agent = await this.connectAgent(agentId);
		return agent.setSessionMode({ sessionId, modeId });
	}

	async setSessionModel(
		agentId: AiBackend,
		sessionId: string,
		modelId: string,
	) {
		const agent = await this.connectAgent(agentId);
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
				const sessions = backend
					? await this.listSessions(backend, workspace)
					: await this.listAllBuiltinSessions(workspace);
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
						msg.data.backend,
						msg.clientId,
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
					msg.data.backend,
					msg.data.sessionId,
					msg.data.cwd,
					{
						additionalDirectories: msg.data.additionalDirectories,
						mcpServers: msg.data.mcpServers as never,
					},
				);
				const agent = await this.connectAgent(msg.data.backend);
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
				await this.closeSession(msg.data.backend, msg.data.sessionId);
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
				const agent = await this.connectAgent(msg.data.backend);
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
				const agent = await this.connectAgent(msg.data.backend);
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
					msg.data.backend,
					msg.clientId,
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

		conn.on(MsgType.AI_SESSION_CONFIG_SET, async (msg) => {
			try {
				const response = await this.setSessionConfigOption(
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
				await this.cancel(msg.data.backend, msg.data.sessionId);
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

		conn.on("disconnected", () => unsubscribe());
	}

	private async listAllBuiltinSessions(
		workspace?: string,
	): Promise<AiSession[]> {
		const results = await Promise.allSettled(
			Object.values(BUILTIN_AGENT_DESCRIPTORS).flatMap((descriptor) =>
				descriptor.id ? [this.listSessions(descriptor.id, workspace)] : [],
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

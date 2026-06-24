import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type {
	AcpAiSession,
	AcpMessage,
	AcpPromptRequest,
	AiAttachmentWriteMsg,
	AiAttachmentWriteResultMsg,
	AiBackend,
	AiEvent,
	AiSession,
	AiSessionCreateMsg,
	AiSessionRuntimeState,
	AiSessionState,
	CustomAcpAgentInput,
	ManagedAcpAgentInfo,
} from "@shellular/protocol";
import { AcpContentBlockSchema, MsgType } from "@shellular/protocol";

import { config } from "@/config";
import type { Connection } from "@/connection";
import { logger } from "@/logger";
import { BUILTIN_AGENT_DESCRIPTORS, isAgentAvailable } from "./agents";
import { ACP } from "./base";
import { ClaudeCode } from "./claude-code";
import { Codex } from "./codex";
import { Copilot } from "./copilot";
import { Cursor } from "./cursor";
import { AgentUnavailableError } from "./errors";
import { Hermes } from "./hermes";
import { OpenCode } from "./opencode";
import { Pi } from "./pi";
import {
	normalizeCustomAgentInput,
	readAgentsConfig,
	toCustomDescriptor,
	writeAgentsConfig,
} from "./store";
import type { AgentDescriptor, AgentInfo } from "./types";

const MAX_AGENT_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const RECENT_SESSION_ACTIVITY_MS = 10 * 60 * 1000;
const SESSION_RUNTIME_IDLE_MS = 2 * 60 * 1000;
const NATIVE_HISTORY_PAGE_SIZE = 30;
type RuntimePatch = Partial<
	Omit<AiSessionRuntimeState, "agentId" | "sessionId" | "updatedAt">
> & {
	updatedAt?: number;
};
type AttachedSessionSnapshot = {
	backend: AiBackend;
	session: AcpAiSession;
	state: AiSessionState;
	runtimeState?: AiSessionRuntimeState;
	messages: AcpMessage[];
	updates: unknown[];
	revision: number;
	syncing?: boolean;
};

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseIsoTimestamp(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function runtimeMetadataFromStatus(
	properties: Record<string, unknown>,
): RuntimePatch | undefined {
	const status = properties.status;
	if (!isRecord(status) || status.sessionUpdate !== "session_info_update") {
		return undefined;
	}
	const patch: RuntimePatch = {};
	if (typeof status.title === "string") patch.title = status.title;
	if (status.title === null) patch.title = undefined;
	const updatedAt = parseIsoTimestamp(status.updatedAt);
	if (updatedAt !== undefined) patch.updatedAt = updatedAt;
	return Object.keys(patch).length > 0 ? patch : undefined;
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
	private disabledAgents = new Set<string>();
	// private customAgentIds = new Set<string>();
	private agents = new Map<string, ACP>();
	private sessionRuntimes = new Map<string, ACP>();
	private sessionSnapshots = new Map<string, AttachedSessionSnapshot>();
	private sessionLoadTasks = new Map<string, Promise<void>>();
	private runtimeIds = new WeakMap<ACP, string>();
	private nextRuntimeId = 0;
	private sessionRuntimeCleanupTimers = new Map<
		string,
		ReturnType<typeof setTimeout>
	>();
	private sessionAgents = new Map<string, string>();

	constructor() {
		this.reloadDescriptors();
	}

	listAgents() {
		this.reloadDescriptors();
		return [...this.descriptors.values()]
			.filter(
				(descriptor) =>
					this.isAgentEnabled(descriptor.id) && isAgentAvailable(descriptor),
			)
			.map((descriptor) => this.getManagedAgentInfo(descriptor));
	}

	listManagedAgents() {
		this.reloadDescriptors();
		return [...this.descriptors.values()].map((descriptor) =>
			this.getManagedAgentInfo(descriptor),
		);
	}

	setAgentEnabled(agentId: AiBackend, enabled: boolean) {
		const descriptor = this.descriptors.get(agentId);
		if (!descriptor) throw new AgentUnavailableError(agentId, "unknown agent");
		const config = readAgentsConfig();
		const disabled = new Set(config.disabled);
		if (enabled) {
			disabled.delete(agentId);
		} else {
			disabled.add(agentId);
			this.destroyAgentRuntimes(agentId);
		}
		writeAgentsConfig({ ...config, disabled: [...disabled].sort() });
		this.reloadDescriptors();
		const updated = this.descriptors.get(agentId);
		if (!updated) throw new AgentUnavailableError(agentId, "unknown agent");
		return this.getManagedAgentInfo(updated);
	}

	addCustomAgent(input: CustomAcpAgentInput) {
		const config = readAgentsConfig();
		const existingIds = new Set([
			...Object.keys(BUILTIN_AGENT_DESCRIPTORS),
			...config.custom.map((agent) => agent.id),
		]);
		const normalized = normalizeCustomAgentInput(input, existingIds);
		writeAgentsConfig({
			...config,
			custom: [...config.custom, normalized],
		});
		this.reloadDescriptors();
		const descriptor = this.descriptors.get(normalized.id);
		if (!descriptor)
			throw new AgentUnavailableError(normalized.id, "unknown agent");
		return this.getManagedAgentInfo(descriptor);
	}

	updateCustomAgent(input: CustomAcpAgentInput) {
		const config = readAgentsConfig();
		const currentIndex = config.custom.findIndex(
			(agent) => agent.id === input.id,
		);
		if (currentIndex < 0) {
			throw new Error("Only custom agents can be edited.");
		}
		const existingIds = new Set([
			...Object.keys(BUILTIN_AGENT_DESCRIPTORS),
			...config.custom
				.filter((agent) => agent.id !== input.id)
				.map((agent) => agent.id),
		]);
		const normalized = normalizeCustomAgentInput(input, existingIds, {
			allowExistingId: input.id,
		});
		const custom = [...config.custom];
		custom[currentIndex] = normalized;
		writeAgentsConfig({ ...config, custom });
		this.destroyAgentRuntimes(normalized.id);
		this.reloadDescriptors();
		const descriptor = this.descriptors.get(normalized.id);
		if (!descriptor)
			throw new AgentUnavailableError(normalized.id, "unknown agent");
		return this.getManagedAgentInfo(descriptor);
	}

	removeCustomAgent(agentId: AiBackend) {
		const config = readAgentsConfig();
		const custom = config.custom.filter((agent) => agent.id !== agentId);
		if (custom.length === config.custom.length) {
			throw new Error("Only custom agents can be removed.");
		}
		writeAgentsConfig({
			disabled: config.disabled.filter((id) => id !== agentId),
			custom,
		});
		this.destroyAgentRuntimes(agentId);
		this.reloadDescriptors();
	}

	private reloadDescriptors() {
		const config = readAgentsConfig();
		this.disabledAgents = new Set(config.disabled);
		// this.customAgentIds = new Set(config.custom.map((agent) => agent.id));
		this.descriptors.clear();
		for (const agent of Object.values(BUILTIN_AGENT_DESCRIPTORS)) {
			this.descriptors.set(agent.id, {
				...agent,
				source: "builtin",
			});
		}
		for (const agent of config.custom) {
			this.descriptors.set(agent.id, toCustomDescriptor(agent));
		}
	}

	private isAgentEnabled(agentId: string) {
		const descriptor = this.descriptors.get(agentId);
		return Boolean(
			descriptor && !descriptor.disabled && !this.disabledAgents.has(agentId),
		);
	}

	private getManagedAgentInfo(
		descriptor: AgentDescriptor,
	): ManagedAcpAgentInfo {
		const runtime = this.agents.get(descriptor.id);
		const runtimeInfo = runtime?.getInfo();
		const installed = isAgentAvailable(descriptor);
		const enabled = this.isAgentEnabled(descriptor.id);
		const state = installed
			? (runtimeInfo?.state ?? "exited")
			: ("unavailable" as const);
		return {
			...runtimeInfo,
			id: descriptor.id,
			backend: descriptor.id,
			name: descriptor.name,
			title: descriptor.title,
			version: runtimeInfo?.version ?? descriptor.version,
			description: descriptor.description,
			note: descriptor.note,
			icon: descriptor.icon,
			source: descriptor.source ?? "builtin",
			state,
			enabled,
			installed,
			available:
				enabled && installed && state !== "unavailable" && state !== "failed",
			installationCommands: descriptor.installationCommands,
			custom:
				descriptor.source === "custom"
					? {
							id: descriptor.id,
							name: descriptor.name,
							title: descriptor.title,
							description: descriptor.description,
							icon: descriptor.icon,
							command: descriptor.spawn.command,
							args: descriptor.spawn.args,
							env: descriptor.spawn.env,
							cwd: descriptor.spawn.cwd,
						}
					: undefined,
			adapter: {
				command: [descriptor.spawn.command, ...descriptor.spawn.args].join(" "),
				available: installed,
			},
		};
	}

	private destroyAgentRuntimes(agentId: string) {
		const shared = this.agents.get(agentId);
		shared?.destroy();
		this.agents.delete(agentId);
		for (const [key, agent] of this.sessionRuntimes.entries()) {
			const [backend] = this.parseSessionKey(key);
			if (backend !== agentId) continue;
			agent.destroy();
			this.sessionRuntimes.delete(key);
			this.sessionRuntimeCleanupTimers.delete(key);
		}
		if (agentId === "codex") Codex.destroyNativeHistoryRuntime();
	}

	listActivities(agentId?: AiBackend) {
		const now = Date.now();
		return [...this.sessionRuntimeStates.values()]
			.filter((activity) => !agentId || activity.agentId === agentId)
			.filter((activity) => this.isAgentEnabled(activity.agentId))
			.filter(
				(activity) =>
					isLiveRuntimeStatus(activity.status) ||
					now - activity.updatedAt <= RECENT_SESSION_ACTIVITY_MS,
			)
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	notifyClient(clientId: string) {
		for (const [agentId, agent] of this.agents.entries()) {
			this.registerPermissionListener(agentId, clientId, agent);
			agent.requestPendingPermissions(clientId);
		}
		for (const [key, agent] of this.sessionRuntimes.entries()) {
			const [agentId] = this.parseSessionKey(key);
			if (!agentId) continue;
			this.registerPermissionListener(agentId, clientId, agent);
			agent.requestPendingPermissions(clientId);
		}
	}

	async connectAgent(clientId: string, agentId: AiBackend) {
		const descriptor = this.descriptors.get(agentId);
		if (!descriptor) {
			throw new AgentUnavailableError(agentId, "unknown agent");
		}
		if (!this.isAgentEnabled(agentId)) {
			throw new AgentUnavailableError(agentId, "agent is disabled");
		}

		let agent = this.agents.get(agentId);
		if (agent && !agent.canReuse()) {
			this.agents.delete(agentId);
			agent = undefined;
		}
		if (!agent) {
			agent = this.createManagedRuntime(agentId);
			this.agents.set(agentId, agent);
		}

		this.registerPermissionListener(agentId, clientId, agent);
		await agent.init();
		return agent;
	}

	private async connectSessionAgent(
		clientId: string,
		agentId: AiBackend,
		sessionId: string,
		initialize = true,
	) {
		const key = this.sessionKey(agentId, sessionId);
		if (!this.isAgentEnabled(agentId)) {
			throw new AgentUnavailableError(agentId, "agent is disabled");
		}
		let agent = this.sessionRuntimes.get(key);
		if (agent && !agent.canReuse()) {
			this.sessionRuntimes.delete(key);
			agent = undefined;
		}
		if (!agent) {
			agent = this.createManagedRuntime(agentId);
			this.sessionRuntimes.set(key, agent);
		}
		this.cancelSessionRuntimeCleanup(agentId, sessionId);
		this.registerPermissionListener(agentId, clientId, agent);
		if (initialize) await agent.init();
		return agent;
	}

	async listSessions(
		clientId: string,
		agentId: AiBackend,
		cwd?: string,
		cursor?: string,
	): Promise<{ sessions: AiSession[]; nextCursor?: string }> {
		if (agentId === "codex") {
			void Codex.warmNativeHistoryRuntime().catch((error) => {
				logger.debug("Unable to prewarm Codex native history", error);
			});
		}
		const agent = await this.connectAgent(clientId, agentId);
		const result = await agent.listAiSessionsPage(cwd, cursor);
		for (const session of result.sessions) {
			this.rememberSessionRuntimeMetadata(agentId, session);
		}
		return result;
	}

	async createSession(
		clientId: string,
		agentId: AiBackend,
		cwd: string,
		options: Parameters<ACP["createSession"]>[1] = {},
	) {
		if (!this.isAgentEnabled(agentId)) {
			throw new AgentUnavailableError(agentId, "agent is disabled");
		}
		const agent = this.createManagedRuntime(agentId);
		this.registerPermissionListener(agentId, clientId, agent);
		await agent.init();
		const result = await agent.createSession(cwd, options);
		const sessionId = result.session.id ?? result.response.sessionId;
		this.sessionRuntimes.set(this.sessionKey(agentId, sessionId), agent);
		this.sessionAgents.set(sessionId, agentId);
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
		const agent = await this.connectSessionAgent(clientId, agentId, sessionId);
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

	async attachSession(
		clientId: string,
		agentId: AiBackend,
		sessionId: string,
		cwd: string,
		options: Partial<
			Omit<Parameters<ACP["loadSession"]>[0], "sessionId" | "cwd">
		> = {},
	) {
		const agent = await this.connectSessionAgent(
			clientId,
			agentId,
			sessionId,
			false,
		);
		this.attachSessionClient(agentId, sessionId, clientId);
		this.rememberSessionClient(agentId, sessionId, clientId);
		const loadParams = {
			...options,
			sessionId,
			cwd,
			mcpServers: options.mcpServers ?? [],
		};
		const key = this.sessionKey(agentId, sessionId);
		if (agent.hasNativeSessionHistory()) {
			try {
				const runtimeWasLoaded = Boolean(agent.getSession(sessionId));
				const history = await agent.readNativeSessionHistory({
					...loadParams,
					limit: NATIVE_HISTORY_PAGE_SIZE,
				});
				agent.seedSessionHistory(sessionId, cwd, history);
				const session = agent.getSession(sessionId) ?? {
					id: sessionId,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					workspacePath: cwd,
				};
				const snapshot = this.setSessionSnapshot(agentId, sessionId, {
					backend: agentId,
					session,
					state: { configOptions: session.configOptions },
					runtimeState: this.rememberSessionRuntimeMetadata(agentId, session),
					messages: history.messages,
					updates: [],
					revision: this.getSessionRevision(agentId, sessionId),
					syncing: !runtimeWasLoaded,
				});
				if (!runtimeWasLoaded) {
					this.restoreNativeSessionRuntime(
						clientId,
						agentId,
						sessionId,
						cwd,
						options,
						history,
					);
				}
				return snapshot;
			} catch (error) {
				logger.warn(
					`Native history read failed for ${agentId}; falling back to ACP replay`,
					error,
				);
			}
		}
		await agent.init();
		const cached = this.sessionSnapshots.get(key);
		if (cached && !agent.hasActivePrompt()) {
			if (!agent.getSession(sessionId)) {
				setTimeout(() => {
					this.refreshSessionSnapshot(
						clientId,
						agentId,
						sessionId,
						cwd,
						options,
						{
							emitSnapshot: true,
						},
					);
				}, 0);
			}
			return {
				...cached,
				runtimeState:
					this.getSessionRuntimeState(agentId, sessionId) ??
					cached.runtimeState,
				revision: this.getSessionRevision(agentId, sessionId),
				syncing: !agent.getSession(sessionId),
			};
		}
		const result = agent.snapshotSession(loadParams, clientId);
		if (!agent.hasActivePrompt()) {
			setTimeout(() => {
				this.refreshSessionSnapshot(
					clientId,
					agentId,
					sessionId,
					cwd,
					options,
					{
						emitSnapshot: true,
					},
				);
			}, 0);
		}
		const session = agent.getSession(sessionId) ?? {
			id: sessionId,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			workspacePath: cwd,
			configOptions: result.response.configOptions ?? undefined,
		};
		const runtimeState = this.rememberSessionRuntimeMetadata(agentId, session);
		return this.setSessionSnapshot(agentId, sessionId, {
			backend: agentId,
			session,
			state: {
				configOptions: result.response.configOptions ?? undefined,
				modes: result.response.modes,
				availableCommands: latestAvailableCommands(result.updates),
			},
			runtimeState,
			messages: result.messages,
			updates: result.updates,
			revision: this.getSessionRevision(agentId, sessionId),
			syncing: !agent.hasActivePrompt(),
		});
	}

	detachSession(clientId: string, agentId: AiBackend, sessionId: string) {
		this.detachSessionClient(agentId, sessionId, clientId);
		this.scheduleSessionRuntimeCleanup(agentId, sessionId);
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
		const agent = await this.connectSessionAgent(clientId, agentId, sessionId);
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
		const agent = await this.connectSessionAgent(clientId, agentId, sessionId);
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
		const agent = await this.connectSessionAgent(clientId, agentId, sessionId);
		const response = await agent.closeSession({ sessionId });
		this.sessionAgents.delete(sessionId);
		this.attachedSessionClients.delete(this.sessionKey(agentId, sessionId));
		this.sessionRevisions.delete(this.sessionKey(agentId, sessionId));
		this.sessionLoadTasks.delete(this.sessionKey(agentId, sessionId));
		this.destroySessionRuntime(agentId, sessionId);
		return response;
	}

	async prompt(
		clientId: string,
		agentId: AiBackend,
		sessionId: string,
		content: string | unknown[],
	) {
		const agent = await this.connectSessionAgent(clientId, agentId, sessionId);
		this.attachSessionClient(agentId, sessionId, clientId);
		this.rememberSessionClient(agentId, sessionId, clientId);
		this.setSessionRuntimeState(agentId, sessionId, {
			status: "running",
			message: "Working",
		});
		this.emit(clientId, agentId, {
			type: "session.status",
			properties: {
				sessionId,
				message: "Working",
			},
		});
		const restoring = this.sessionLoadTasks.get(
			this.sessionKey(agentId, sessionId),
		);
		if (restoring) await restoring;
		if (!agent.getSession(sessionId)) {
			await this.ensureSessionRuntimeLoaded(clientId, agentId, sessionId);
		}
		const prompt = normalizePromptContent(content);
		const result = await agent.prompt(
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
		const snapshot = this.sessionSnapshots.get(
			this.sessionKey(agentId, sessionId),
		);
		if (snapshot) {
			this.sessionSnapshots.set(this.sessionKey(agentId, sessionId), {
				...snapshot,
				messages: result.messages,
				revision: this.getSessionRevision(agentId, sessionId),
			});
		}
		return result;
	}

	private async ensureSessionRuntimeLoaded(
		clientId: string,
		agentId: AiBackend,
		sessionId: string,
	) {
		const key = this.sessionKey(agentId, sessionId);
		const existingLoad = this.sessionLoadTasks.get(key);
		if (existingLoad) {
			await existingLoad;
			return;
		}
		const snapshot = this.sessionSnapshots.get(key);
		if (!snapshot?.session.workspacePath) return;
		this.refreshSessionSnapshot(
			clientId,
			agentId,
			sessionId,
			snapshot.session.workspacePath,
			{},
			{ emitSnapshot: true },
		);
		const load = this.sessionLoadTasks.get(key);
		if (load) await load;
	}

	async cancel(clientId: string, agentId: AiBackend, sessionId: string) {
		const agent = await this.connectSessionAgent(clientId, agentId, sessionId);
		this.setSessionRuntimeState(agentId, sessionId, {
			status: "stopping",
			message: "Stopping",
		});
		this.emit(clientId, agentId, {
			type: "session.status",
			properties: {
				sessionId,
				message: "Stopping",
			},
		});
		const result = await agent.interrupt({ sessionId });
		this.setSessionRuntimeState(agentId, sessionId, {
			status: "stopped",
			message: "Stopped",
		});
		this.emit(clientId, agentId, {
			type: "session.status",
			properties: {
				sessionId,
				message: "Stopped",
			},
		});
		this.scheduleSessionRuntimeCleanup(agentId, sessionId);
		return result;
	}

	async replyPermission(
		clientId: string,
		agentId: AiBackend,
		sessionId: string,
		permissionId: string,
		optionId: string | undefined,
	) {
		if (!optionId) {
			throw new Error("ACP permission reply requires an optionId");
		}
		const agent = await this.connectSessionAgent(clientId, agentId, sessionId);
		return agent.replyPermission(permissionId, optionId);
	}

	async setSessionConfigOption(
		clientId: string,
		agentId: AiBackend,
		sessionId: string,
		configId: string,
		value: string | boolean,
	) {
		const agent = await this.connectSessionAgent(clientId, agentId, sessionId);
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
		const agent = await this.connectSessionAgent(clientId, agentId, sessionId);
		return agent.setSessionMode({ sessionId, modeId });
	}

	destroy() {
		for (const agent of this.agents.values()) {
			agent.destroy();
		}
		for (const agent of this.sessionRuntimes.values()) {
			agent.destroy();
		}
		for (const timer of this.sessionRuntimeCleanupTimers.values()) {
			clearTimeout(timer);
		}
		this.agents.clear();
		this.sessionRuntimes.clear();
		this.sessionRuntimeCleanupTimers.clear();
		this.sessionAgents.clear();
		Codex.destroyNativeHistoryRuntime();
	}

	getAvailableAgents(): AiBackend[] {
		this.reloadDescriptors();
		return [...this.descriptors.values()].flatMap((descriptor) =>
			this.isAgentEnabled(descriptor.id) && isAgentAvailable(descriptor)
				? [descriptor.id]
				: [],
		);
	}

	private subscribers = new Set<
		(clientId: string, backend: AiBackend, event: AiEvent) => void
	>();
	private sessionClientIds = new Map<string, string>();
	private attachedSessionClients = new Map<string, Set<string>>();
	private sessionRevisions = new Map<string, number>();
	private sessionRuntimeStates = new Map<string, AiSessionRuntimeState>();
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
					revision: event.revision,
					state: "state" in event ? event.state : undefined,
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
			const agents = this.listAgents();
			conn.send({
				type: MsgType.AI_AGENTS_LIST_RESULT,
				clientId: msg.clientId,
				respTo: msg.id,
				data: { agents },
			});
		});

		conn.on(MsgType.AI_AGENTS_MANAGE_LIST, (msg) => {
			conn.send({
				type: MsgType.AI_AGENTS_MANAGE_LIST_RESULT,
				clientId: msg.clientId,
				respTo: msg.id,
				data: { ok: true, agents: this.listManagedAgents() },
			});
		});

		conn.on(MsgType.AI_AGENTS_ENABLE_SET, (msg) => {
			try {
				const agent = this.setAgentEnabled(msg.data.backend, msg.data.enabled);
				conn.send({
					type: MsgType.AI_AGENTS_ENABLE_SET_RESULT,
					clientId: msg.clientId,
					respTo: msg.id,
					data: { ok: true, agent },
				});
			} catch (err) {
				conn.send({
					type: MsgType.AI_AGENTS_ENABLE_SET_RESULT,
					clientId: msg.clientId,
					respTo: msg.id,
					error: getErrorMessage(err),
					data: { ok: false },
				});
			}
		});

		conn.on(MsgType.AI_AGENTS_CUSTOM_ADD, (msg) => {
			try {
				const agent = this.addCustomAgent(msg.data);
				conn.send({
					type: MsgType.AI_AGENTS_CUSTOM_ADD_RESULT,
					clientId: msg.clientId,
					respTo: msg.id,
					data: { ok: true, agent },
				});
			} catch (err) {
				conn.send({
					type: MsgType.AI_AGENTS_CUSTOM_ADD_RESULT,
					clientId: msg.clientId,
					respTo: msg.id,
					error: getErrorMessage(err),
					data: { ok: false },
				});
			}
		});

		conn.on(MsgType.AI_AGENTS_CUSTOM_UPDATE, (msg) => {
			try {
				const agent = this.updateCustomAgent(msg.data);
				conn.send({
					type: MsgType.AI_AGENTS_CUSTOM_UPDATE_RESULT,
					clientId: msg.clientId,
					respTo: msg.id,
					data: { ok: true, agent },
				});
			} catch (err) {
				conn.send({
					type: MsgType.AI_AGENTS_CUSTOM_UPDATE_RESULT,
					clientId: msg.clientId,
					respTo: msg.id,
					error: getErrorMessage(err),
					data: { ok: false },
				});
			}
		});

		conn.on(MsgType.AI_AGENTS_CUSTOM_REMOVE, (msg) => {
			try {
				this.removeCustomAgent(msg.data.backend);
				conn.send({
					type: MsgType.AI_AGENTS_CUSTOM_REMOVE_RESULT,
					clientId: msg.clientId,
					respTo: msg.id,
					data: { ok: true, agents: this.listManagedAgents() },
				});
			} catch (err) {
				conn.send({
					type: MsgType.AI_AGENTS_CUSTOM_REMOVE_RESULT,
					clientId: msg.clientId,
					respTo: msg.id,
					error: getErrorMessage(err),
					data: { ok: false },
				});
			}
		});

		conn.on(MsgType.AI_ACTIVITY_LIST, (msg) => {
			conn.send({
				type: MsgType.AI_ACTIVITY_LIST_RESULT,
				clientId: msg.clientId,
				respTo: msg.id,
				data: {
					activities: this.listActivities(msg.data?.backend),
				},
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
				const runtimeState = this.rememberSessionRuntimeMetadata(
					msg.data.backend,
					session,
				);
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
							modes: response.modes,
						},
						runtimeState,
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
				const agent = await this.connectSessionAgent(
					msg.clientId,
					msg.data.backend,
					msg.data.sessionId,
				);
				const session = agent.getSession(msg.data.sessionId) ?? {
					id: msg.data.sessionId,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					workspacePath: msg.data.cwd,
					configOptions: result.response.configOptions ?? undefined,
				};
				const runtimeState = this.rememberSessionRuntimeMetadata(
					msg.data.backend,
					session,
				);
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
							modes: result.response.modes,
						},
						runtimeState,
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

		conn.on(MsgType.AI_SESSION_ATTACH, async (msg) => {
			try {
				const result = await this.attachSession(
					msg.clientId,
					msg.data.backend,
					msg.data.sessionId,
					msg.data.cwd,
					{
						additionalDirectories: msg.data.additionalDirectories,
						mcpServers: msg.data.mcpServers as never,
					},
				);
				conn.send({
					type: MsgType.AI_SESSION_ATTACH_RESULT,
					clientId: msg.clientId,
					respTo: msg.id,
					data: result,
				});
			} catch (err) {
				conn.send({
					type: MsgType.AI_SESSION_ATTACH_RESULT,
					clientId: msg.clientId,
					respTo: msg.id,
					error: getErrorMessage(err),
				});
			}
		});

		conn.on(MsgType.AI_SESSION_DETACH, (msg) => {
			try {
				this.detachSession(msg.clientId, msg.data.backend, msg.data.sessionId);
				conn.send({
					type: MsgType.AI_SESSION_DETACH_RESULT,
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
					type: MsgType.AI_SESSION_DETACH_RESULT,
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
				const runtimeState = this.rememberSessionRuntimeMetadata(
					msg.data.backend,
					result.session,
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
							modes: result.response.modes,
						},
						runtimeState,
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
				const runtimeState = this.rememberSessionRuntimeMetadata(
					msg.data.backend,
					result.session,
				);
				conn.send({
					type: MsgType.AI_SESSION_FORK_RESULT,
					clientId: msg.clientId,
					respTo: msg.id,
					data: {
						backend: msg.data.backend,
						session: result.session,
						state: {
							configOptions: result.response.configOptions ?? undefined,
							modes: result.response.modes,
						},
						runtimeState,
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
				const agent = await this.connectSessionAgent(
					msg.clientId,
					msg.data.backend,
					msg.data.sessionId,
				);
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
				const agent = await this.connectSessionAgent(
					msg.clientId,
					msg.data.backend,
					msg.data.sessionId,
					false,
				);
				const messages = agent.hasNativeSessionHistory()
					? (
							await agent.readNativeSessionHistory({
								sessionId: msg.data.sessionId,
								cwd:
									msg.data.cwd ??
									agent.getSession(msg.data.sessionId)?.workspacePath ??
									".",
								mcpServers: [],
								cursor: msg.data.cursor,
								limit: msg.data.limit ?? NATIVE_HISTORY_PAGE_SIZE,
							})
						).messages
					: agent.getMessages(msg.data.sessionId);
				conn.send({
					type: MsgType.AI_MESSAGES_LIST_RESULT,
					clientId: msg.clientId,
					respTo: msg.id,
					data: {
						backend: msg.data.backend,
						messages,
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
				).catch((err) => {
					this.emit(msg.clientId, msg.data.backend, {
						type: "error",
						properties: {
							sessionId: msg.data.sessionId,
							error: getErrorMessage(err),
						},
					});
				});
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
				this.setSessionRuntimeState(msg.data.backend, msg.data.sessionId, {
					status: "running",
					message: "Working",
				});
				this.emit(msg.clientId, msg.data.backend, {
					type: "session.status",
					properties: {
						sessionId: msg.data.sessionId,
						message: "Working",
					},
				});
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
			this.detachClientFromAllSessions(msg.data.clientId);
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
			[...this.descriptors.values()].flatMap((descriptor) =>
				this.isAgentEnabled(descriptor.id) && isAgentAvailable(descriptor)
					? [
							this.connectAgent(clientId, descriptor.id).then(
								async (agent) => ({
									agentId: descriptor.id,
									sessions: await agent.listAiSessions(workspace),
								}),
							),
						]
					: [],
			),
		);
		return results
			.flatMap((result) => {
				if (result.status !== "fulfilled") return [];
				for (const session of result.value.sessions) {
					this.rememberSessionRuntimeMetadata(result.value.agentId, session);
				}
				return result.value.sessions;
			})
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	private emit(clientId: string, backend: AiBackend, event: AiEvent) {
		const state = this.applyEventRuntimeState(backend, event);
		const sessionId = event.properties.sessionId;
		const revision =
			typeof sessionId === "string"
				? this.nextSessionRevision(backend, sessionId)
				: undefined;
		const enrichedEvent = {
			...event,
			...(state ? { state } : {}),
			...(revision !== undefined ? { revision } : {}),
		};
		if (typeof sessionId === "string" && event.type === "message") {
			const message = event.properties.message;
			if (isRecord(message)) {
				this.upsertSnapshotMessage(backend, sessionId, message as AcpMessage);
			}
		}
		const targets =
			typeof sessionId === "string"
				? this.getEventTargetClientIds(backend, sessionId, clientId)
				: [clientId];
		for (const subscriber of this.subscribers) {
			for (const targetClientId of targets) {
				subscriber(targetClientId, backend, enrichedEvent);
			}
		}
		if (
			typeof sessionId === "string" &&
			state &&
			!isLiveRuntimeStatus(state.status)
		) {
			this.scheduleSessionRuntimeCleanup(backend, sessionId);
		}
	}

	private sessionKey(agentId: string, sessionId: string) {
		return `${agentId}:${sessionId}`;
	}

	private setSessionSnapshot(
		agentId: AiBackend,
		sessionId: string,
		snapshot: AttachedSessionSnapshot,
	) {
		this.sessionSnapshots.set(this.sessionKey(agentId, sessionId), snapshot);
		return snapshot;
	}

	private upsertSnapshotMessage(
		agentId: AiBackend,
		sessionId: string,
		message: AcpMessage,
	) {
		const key = this.sessionKey(agentId, sessionId);
		const snapshot = this.sessionSnapshots.get(key);
		if (!snapshot) return;
		const existingIndex = message.id
			? snapshot.messages.findIndex((item) => item.id === message.id)
			: -1;
		const messages =
			existingIndex >= 0
				? snapshot.messages.map((item, index) =>
						index === existingIndex ? message : item,
					)
				: [...snapshot.messages, message];
		this.sessionSnapshots.set(key, {
			...snapshot,
			messages,
			revision: this.getSessionRevision(agentId, sessionId),
		});
	}

	private refreshSessionSnapshot(
		clientId: string,
		agentId: AiBackend,
		sessionId: string,
		cwd: string,
		options: Partial<
			Omit<Parameters<ACP["loadSession"]>[0], "sessionId" | "cwd">
		>,
		behavior: { emitSnapshot?: boolean } = {},
	) {
		const key = this.sessionKey(agentId, sessionId);
		const agent = this.sessionRuntimes.get(key);
		if (!agent || agent.hasActivePrompt()) return;
		if (this.sessionLoadTasks.has(key)) return;
		if (behavior.emitSnapshot) {
			this.emit(this.sessionClientIds.get(key) ?? "", agentId, {
				type: "session.status",
				properties: { sessionId, syncing: "messages" },
			});
		}
		const task = agent
			.loadSession(
				{
					...options,
					sessionId,
					cwd,
					mcpServers: options.mcpServers ?? [],
				},
				clientId,
			)
			.then((result) => {
				const session = agent.getSession(sessionId);
				if (!session) return;
				const runtimeState = this.rememberSessionRuntimeMetadata(
					agentId,
					session,
				);
				this.setSessionSnapshot(agentId, sessionId, {
					backend: agentId,
					session,
					state: {
						configOptions: result.response.configOptions ?? undefined,
						modes: result.response.modes,
						availableCommands: latestAvailableCommands(result.updates),
					},
					runtimeState,
					messages: result.messages,
					updates: result.updates,
					revision: this.getSessionRevision(agentId, sessionId),
				});
				if (behavior.emitSnapshot) {
					this.emitSessionSnapshot(agentId, sessionId, {
						messages: result.messages,
						state: {
							configOptions: result.response.configOptions ?? undefined,
							modes: result.response.modes,
							availableCommands: latestAvailableCommands(result.updates),
						},
						runtimeState,
					});
				}
			})
			.catch(() => {})
			.finally(() => {
				if (behavior.emitSnapshot) {
					this.emit(this.sessionClientIds.get(key) ?? "", agentId, {
						type: "session.status",
						properties: { sessionId, syncing: false },
					});
				}
				if (this.sessionLoadTasks.get(key) === task) {
					this.sessionLoadTasks.delete(key);
				}
			});
		this.sessionLoadTasks.set(key, task);
	}

	private restoreNativeSessionRuntime(
		clientId: string,
		agentId: AiBackend,
		sessionId: string,
		cwd: string,
		options: Partial<
			Omit<Parameters<ACP["loadSession"]>[0], "sessionId" | "cwd">
		>,
		history: { messages: AcpMessage[] },
	) {
		const key = this.sessionKey(agentId, sessionId);
		const agent = this.sessionRuntimes.get(key);
		if (!agent || this.sessionLoadTasks.has(key)) return;
		const params = {
			...options,
			sessionId,
			cwd,
			mcpServers: options.mcpServers ?? [],
		};
		const restore = agent
			.init()
			.then(() =>
				agent.capabilities?.sessionCapabilities?.resume
					? agent.resumeSession(params).then((result) => result.response)
					: agent
							.loadSession(params, clientId)
							.then((result) => result.response),
			);
		const task = restore
			.then((response) => {
				// ACP restore is the execution/control plane. Keep the transcript from
				// the native authoritative read rather than its slower replay stream.
				agent.seedSessionHistory(sessionId, cwd, history);
				const session = agent.getSession(sessionId);
				if (!session) return;
				const snapshot = this.sessionSnapshots.get(key);
				this.setSessionSnapshot(agentId, sessionId, {
					backend: agentId,
					session: {
						...session,
						configOptions: response.configOptions ?? session.configOptions,
					},
					state: {
						...(snapshot?.state ?? {}),
						configOptions: response.configOptions ?? session.configOptions,
					},
					runtimeState: this.getSessionRuntimeState(agentId, sessionId),
					messages: history.messages,
					updates: snapshot?.updates ?? [],
					revision: this.getSessionRevision(agentId, sessionId),
					syncing: false,
				});
			})
			.catch((error) => {
				logger.warn(`Unable to restore ${agentId} session ${sessionId}`, error);
				this.emit(this.sessionClientIds.get(key) ?? clientId, agentId, {
					type: "error",
					properties: {
						sessionId,
						error: getErrorMessage(error),
					},
				});
			})
			.finally(() => {
				this.emit(this.sessionClientIds.get(key) ?? clientId, agentId, {
					type: "session.status",
					properties: { sessionId, syncing: false },
				});
				if (this.sessionLoadTasks.get(key) === task) {
					this.sessionLoadTasks.delete(key);
				}
			});
		this.sessionLoadTasks.set(key, task);
	}

	private emitSessionSnapshot(
		agentId: AiBackend,
		sessionId: string,
		snapshot: {
			messages: AcpMessage[];
			state: AiSessionState;
			runtimeState?: AiSessionRuntimeState;
		},
	) {
		this.emit(
			this.sessionClientIds.get(this.sessionKey(agentId, sessionId)) ?? "",
			agentId,
			{
				type: "session.snapshot",
				properties: {
					sessionId,
					messages: snapshot.messages,
					state: snapshot.state,
					runtimeState: snapshot.runtimeState,
				},
			},
		);
	}

	private createManagedRuntime(agentId: AiBackend): ACP {
		const descriptor = this.descriptors.get(agentId);
		if (!descriptor) {
			throw new AgentUnavailableError(agentId, "unknown agent");
		}
		if (!this.isAgentEnabled(agentId)) {
			throw new AgentUnavailableError(agentId, "agent is disabled");
		}
		const agent = createAgentRuntime(agentId, descriptor);
		this.runtimeIds.set(agent, `runtime_${++this.nextRuntimeId}`);
		agent.onSessionUpdate((notification) => {
			const backend = descriptor.id;
			const key = this.sessionKey(descriptor.id, notification.sessionId);
			const clientId =
				this.sessionClientIds.get(key) ??
				this.attachedSessionClients.get(key)?.values().next().value ??
				"";
			if (!clientId) return;
			const status = sessionStatusEvent(notification);
			if (status) this.emit(clientId, backend, status);
		});
		return agent;
	}

	private attachSessionClient(
		agentId: AiBackend,
		sessionId: string,
		clientId: string,
	) {
		const key = this.sessionKey(agentId, sessionId);
		let clients = this.attachedSessionClients.get(key);
		if (!clients) {
			clients = new Set();
			this.attachedSessionClients.set(key, clients);
		}
		clients.add(clientId);
	}

	private detachSessionClient(
		agentId: AiBackend,
		sessionId: string,
		clientId: string,
	) {
		const key = this.sessionKey(agentId, sessionId);
		const clients = this.attachedSessionClients.get(key);
		if (!clients) return;
		clients.delete(clientId);
		if (!clients.size) this.attachedSessionClients.delete(key);
	}

	private detachClientFromAllSessions(clientId: string) {
		if (!clientId) return;
		for (const [key, clients] of this.attachedSessionClients.entries()) {
			clients.delete(clientId);
			if (!clients.size) {
				this.attachedSessionClients.delete(key);
				const [agentId, sessionId] = this.parseSessionKey(key);
				if (agentId && sessionId) {
					this.scheduleSessionRuntimeCleanup(agentId as AiBackend, sessionId);
				}
			}
		}
	}

	private parseSessionKey(key: string): [string, string] {
		const index = key.indexOf(":");
		return index < 0 ? ["", ""] : [key.slice(0, index), key.slice(index + 1)];
	}

	private cancelSessionRuntimeCleanup(agentId: AiBackend, sessionId: string) {
		const key = this.sessionKey(agentId, sessionId);
		const timer = this.sessionRuntimeCleanupTimers.get(key);
		if (!timer) return;
		clearTimeout(timer);
		this.sessionRuntimeCleanupTimers.delete(key);
	}

	private scheduleSessionRuntimeCleanup(agentId: AiBackend, sessionId: string) {
		const key = this.sessionKey(agentId, sessionId);
		if (!this.sessionRuntimes.has(key)) return;
		if (this.attachedSessionClients.get(key)?.size) return;
		const activity = this.getSessionRuntimeState(agentId, sessionId);
		if (activity && isLiveRuntimeStatus(activity.status)) return;
		this.cancelSessionRuntimeCleanup(agentId, sessionId);
		const timer = setTimeout(() => {
			const current = this.getSessionRuntimeState(agentId, sessionId);
			if (this.attachedSessionClients.get(key)?.size) return;
			if (current && isLiveRuntimeStatus(current.status)) return;
			this.destroySessionRuntime(agentId, sessionId);
		}, SESSION_RUNTIME_IDLE_MS);
		this.sessionRuntimeCleanupTimers.set(key, timer);
	}

	private destroySessionRuntime(agentId: AiBackend, sessionId: string) {
		const key = this.sessionKey(agentId, sessionId);
		this.cancelSessionRuntimeCleanup(agentId, sessionId);
		const agent = this.sessionRuntimes.get(key);
		if (!agent) return;
		agent.destroy();
		this.sessionRuntimes.delete(key);
	}

	private getEventTargetClientIds(
		agentId: AiBackend,
		sessionId: string,
		fallbackClientId: string,
	): string[] {
		const attached = this.attachedSessionClients.get(
			this.sessionKey(agentId, sessionId),
		);
		if (attached?.size) return [...attached];
		return fallbackClientId ? [fallbackClientId] : [];
	}

	private getSessionRevision(agentId: AiBackend, sessionId: string) {
		return this.sessionRevisions.get(this.sessionKey(agentId, sessionId)) ?? 0;
	}

	private nextSessionRevision(agentId: AiBackend, sessionId: string) {
		const key = this.sessionKey(agentId, sessionId);
		const next = (this.sessionRevisions.get(key) ?? 0) + 1;
		this.sessionRevisions.set(key, next);
		return next;
	}

	private permissionListenerKey(agentId: string, clientId: string, agent: ACP) {
		return `${agentId}\0${clientId}\0${this.runtimeIds.get(agent) ?? "default"}`;
	}

	private getSessionRuntimeState(agentId: string, sessionId: string) {
		return this.sessionRuntimeStates.get(this.sessionKey(agentId, sessionId));
	}

	private setSessionRuntimeState(
		agentId: AiBackend,
		sessionId: string,
		patch: RuntimePatch,
	): AiSessionRuntimeState {
		const key = this.sessionKey(agentId, sessionId);
		const previous = this.sessionRuntimeStates.get(key);
		const next: AiSessionRuntimeState = {
			status: previous?.status ?? "stopped",
			...(previous?.title ? { title: previous.title } : {}),
			...(previous?.workspacePath
				? { workspacePath: previous.workspacePath }
				: {}),
			...(previous?.model ? { model: previous.model } : {}),
			...(previous?.message ? { message: previous.message } : {}),
			...(previous?.stopReason ? { stopReason: previous.stopReason } : {}),
			...(previous?.error ? { error: previous.error } : {}),
			...(previous?.pendingPermission
				? { pendingPermission: previous.pendingPermission }
				: {}),
			...patch,
			agentId,
			sessionId,
			updatedAt: patch.updatedAt ?? Date.now(),
		};
		if (
			next.status !== "waiting_for_permission" &&
			patch.pendingPermission === undefined
		) {
			delete next.pendingPermission;
		}
		if (next.status !== "error" && patch.error === undefined) {
			delete next.error;
		}
		if (
			next.status !== "finished" &&
			next.status !== "cancelled" &&
			patch.stopReason === undefined
		) {
			delete next.stopReason;
		}
		this.sessionRuntimeStates.set(key, next);
		return next;
	}

	private rememberSessionRuntimeMetadata(
		agentId: AiBackend,
		session: AiSession,
	): AiSessionRuntimeState | undefined {
		if (!session.id) return undefined;
		const patch: RuntimePatch = {
			updatedAt:
				this.getSessionRuntimeState(agentId, session.id)?.updatedAt ??
				session.updatedAt ??
				Date.now(),
		};
		if (session.title) patch.title = session.title;
		if (session.workspacePath) patch.workspacePath = session.workspacePath;
		if (session.model) patch.model = session.model;
		return this.setSessionRuntimeState(agentId, session.id, patch);
	}

	private applyEventRuntimeState(
		agentId: AiBackend,
		event: AiEvent,
	): AiSessionRuntimeState | undefined {
		const sessionId = event.properties.sessionId;
		if (typeof sessionId !== "string") return undefined;

		switch (event.type) {
			case "token":
			case "message":
				return this.setSessionRuntimeState(agentId, sessionId, {
					status: "running",
					message: "Working",
				});
			case "permission.updated":
				return this.setSessionRuntimeState(agentId, sessionId, {
					status: "waiting_for_permission",
					message: "Waiting for permission",
					pendingPermission: event.properties,
				});
			case "cancelled":
				return this.setSessionRuntimeState(agentId, sessionId, {
					status: "cancelled",
					message: "Cancelled",
					stopReason: "cancelled",
				});
			case "end": {
				const stopReason = event.properties.stopReason;
				const status = stopReason === "cancelled" ? "cancelled" : "finished";
				return this.setSessionRuntimeState(agentId, sessionId, {
					status,
					message: status === "cancelled" ? "Cancelled" : "Finished",
					stopReason: typeof stopReason === "string" ? stopReason : undefined,
				});
			}
			case "error":
			case "prompt_error": {
				const error = event.properties.error;
				return this.setSessionRuntimeState(agentId, sessionId, {
					status: "error",
					message: "Error",
					error: typeof error === "string" ? error : undefined,
				});
			}
			case "session.status": {
				const metadata = runtimeMetadataFromStatus(event.properties);
				if (metadata) {
					return this.setSessionRuntimeState(agentId, sessionId, metadata);
				}
				return this.getSessionRuntimeState(agentId, sessionId);
			}
			default:
				return this.getSessionRuntimeState(agentId, sessionId);
		}
	}

	private registerPermissionListener(
		agentId: string,
		clientId: string,
		agent: ACP,
	) {
		const key = this.permissionListenerKey(agentId, clientId, agent);
		if (this.permissionListenerCleanups.has(key)) return;
		const descriptor = this.descriptors.get(agentId);
		if (!descriptor) return;

		// ACP permission requests are client-side JSON-RPC calls. Convert them
		// into the existing Shellular event stream so the mobile app can decide.
		const cleanup = agent.onPermission(clientId, (permission) => {
			const key = this.sessionKey(agentId, permission.sessionId);
			const attached = this.attachedSessionClients.get(key);
			const attachedTargets = attached ? [...attached] : [];
			if (attachedTargets.length > 0 && attachedTargets[0] !== clientId) {
				return;
			}
			const targetClientId =
				attachedTargets[0] ?? this.sessionClientIds.get(key);
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
		for (const [key, cleanup] of this.permissionListenerCleanups.entries()) {
			const [, keyClientId] = key.split("\0");
			if (keyClientId !== clientId) continue;
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

function createAgentRuntime(
	agentId: AiBackend,
	descriptor: AgentDescriptor,
): ACP {
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
			if (descriptor.source === "custom") {
				return new ACP(descriptor);
			}
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

function isLiveRuntimeStatus(status: AiSessionRuntimeState["status"]) {
	return (
		status === "starting" ||
		status === "running" ||
		status === "waiting_for_permission" ||
		status === "stopping"
	);
}

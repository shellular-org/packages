import type { AiBackend, AiSession } from "@shellular/protocol";
import { logger } from "@/logger";
import { ClaudeCodeProvider } from "./claude-code";
import { CodexProvider } from "./codex";
import { CopilotProvider } from "./copilot";
import type {
	AIProvider,
	AiEvent,
	CodexPromptOptions,
	FileAttachment,
	ModelSelector,
} from "./interface";
import { OpenCodeProvider } from "./opencode";

export class AiManager {
	private _providers: Partial<Record<AiBackend, AIProvider>> = {};
	private _available: AiBackend[] = [];
	private _sessionClientIds = new Map<string, string>();

	private sessionKey(backend: AiBackend, sessionId: string): string {
		return `${backend}:${sessionId}`;
	}

	private rememberSessionClient(
		backend: AiBackend,
		sessionId: string | undefined,
		clientId?: string,
	): void {
		if (!sessionId || !clientId) return;
		this._sessionClientIds.set(this.sessionKey(backend, sessionId), clientId);
	}

	private forgetSessionClient(backend: AiBackend, sessionId: string): void {
		this._sessionClientIds.delete(this.sessionKey(backend, sessionId));
	}

	private getLoadedProvider(backend: AiBackend): AIProvider | null {
		return this._providers[backend] ?? null;
	}

	private pickString(...values: unknown[]): string | undefined {
		for (const value of values) {
			if (typeof value === "string" && value.length > 0) return value;
		}
		return undefined;
	}

	private getEventProperties(event: AiEvent): Record<string, unknown> {
		if (
			!("properties" in event) ||
			!event.properties ||
			typeof event.properties !== "object"
		) {
			return {};
		}
		return event.properties as Record<string, unknown>;
	}

	private getEventSessionId(event: AiEvent): string | undefined {
		const props = this.getEventProperties(event);
		const info =
			typeof props.info === "object" && props.info !== null
				? (props.info as Record<string, unknown>)
				: undefined;
		const message =
			typeof props.message === "object" && props.message !== null
				? (props.message as Record<string, unknown>)
				: undefined;

		return this.pickString(
			props.sessionId,
			props.threadId,
			info?.id,
			info?.sessionId,
			message?.sessionId,
			message?.threadId,
		);
	}

	private attachClientId(backend: AiBackend, event: AiEvent): AiEvent {
		const props = this.getEventProperties(event);
		const existingClientId = this.pickString(props.clientId);
		if (existingClientId) return event;

		const sessionId = this.getEventSessionId(event);
		if (!sessionId) return event;

		const clientId = this._sessionClientIds.get(
			this.sessionKey(backend, sessionId),
		);
		if (!clientId) return event;

		return {
			...event,
			properties: {
				...props,
				clientId,
			},
		};
	}

	async init(): Promise<AiBackend[]> {
		await Promise.allSettled([
			this.tryInit("opencode"),
			this.tryInit("codex"),
			this.tryInit("copilot"),
			this.tryInit("claude-code"),
		]);
		if (this._available.length === 0) {
			logger.warn(
				"No AI backends available. CLI will continue without AI features.",
			);
			return this._available;
		}

		logger.log(`Available AI backends: ${this._available.join(", ")}`);
		return this._available;
	}

	private async tryInit(backend: AiBackend): Promise<void> {
		try {
			if (backend === "opencode") {
				const p = new OpenCodeProvider();
				await p.init();
				this._providers.opencode = p;
			} else if (backend === "codex") {
				const p = new CodexProvider();
				await p.init();
				this._providers.codex = p;
			} else if (backend === "copilot") {
				const p = new CopilotProvider();
				await p.init();
				this._providers.copilot = p;
			} else if (backend === "claude-code") {
				const p = new ClaudeCodeProvider();
				await p.init();
				this._providers["claude-code"] = p;
			}
			this._available.push(backend);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException | undefined)?.code;
			if (code === "ENOENT") {
				logger.warn(`${backend} backend not available`);
				return;
			}

			logger.error(`Critical error initializing ${backend}:`, err);
			logger.warn(`${backend} backend not available`);
		}
	}

	availableBackends(): AiBackend[] {
		return [...this._available];
	}

	private get(backend: AiBackend): AIProvider {
		const p = this._providers[backend];
		if (!p) {
			throw Object.assign(new Error(`Backend "${backend}" is not available`), {
				code: "EUNAVAILABLE",
			});
		}
		return p;
	}

	subscribe(
		emitter: (clientId: string, backend: AiBackend, event: AiEvent) => void,
	): () => void {
		const cleanups = this._available.flatMap((backend) => {
			const provider = this.getLoadedProvider(backend);
			if (!provider) return [];
			return [
				provider.subscribe((clientId, event) =>
					emitter(clientId, backend, this.attachClientId(backend, event)),
				),
			];
		});
		return () =>
			cleanups.forEach((c) => {
				c();
			});
	}

	async destroy(): Promise<void> {
		try {
			await Promise.allSettled(
				this._available.flatMap((backend) => {
					const provider = this.getLoadedProvider(backend);
					return provider ? [provider.destroy()] : [];
				}),
			);

			logger.log("AIManager cleanup complete.");
		} catch (err) {
			logger.error(`Error during AIManager cleanup:`, err);
		}
	}

	async listSessions(clientId: string, backend: AiBackend) {
		return this.get(backend).listSessions(clientId);
	}

	async listAllSessions(clientId: string): Promise<AiSession[]> {
		const results = await Promise.allSettled(
			this._available.map(async (backend) => {
				const provider = this.getLoadedProvider(backend);
				if (!provider) return [];
				return await provider.listSessions(clientId);
			}),
		);
		const sessions = results.flatMap((r) =>
			r.status === "fulfilled" ? r.value : [],
		);
		sessions.sort((a, b) => b.updatedAt - a.updatedAt);
		return sessions;
	}

	async createSession(
		clientId: string,
		backend: AiBackend,
		prompt: string,
		workspacePath: string,
	) {
		const result = await this.get(backend).createSession(
			prompt,
			clientId,
			workspacePath,
		);
		this.rememberSessionClient(backend, result.id, clientId);
		return result;
	}
	getSession(clientId: string, backend: AiBackend, id: string) {
		return this.get(backend).getSession(clientId, id);
	}
	async deleteSession(clientId: string, backend: AiBackend, id: string) {
		const deleted = await this.get(backend).deleteSession(clientId, id);
		if (deleted) this.forgetSessionClient(backend, id);
		return deleted;
	}
	getMessages(clientId: string, backend: AiBackend, sessionId: string) {
		return this.get(backend).getMessages(clientId, sessionId);
	}

	prompt(
		clientId: string,
		backend: AiBackend,
		sessionId: string,
		text: string,
		model?: ModelSelector,
		agent?: string,
		files?: FileAttachment[],
		codexOptions?: CodexPromptOptions,
	) {
		this.rememberSessionClient(backend, sessionId, clientId);
		this.get(backend).setActiveSession?.(sessionId);
		return this.get(backend).prompt(
			clientId,
			sessionId,
			text,
			model,
			agent,
			files,
			codexOptions,
		);
	}

	abort(clientId: string, backend: AiBackend, sessionId: string) {
		return this.get(backend).abort(clientId, sessionId);
	}

	agents(clientId: string, backend?: AiBackend) {
		return this.get(backend ?? this._available[0]).agents(clientId);
	}
	providers(clientId: string, backend?: AiBackend) {
		return this.get(backend ?? this._available[0]).providers(clientId);
	}
	setAuth(
		clientId: string,
		backend: AiBackend,
		providerId: string,
		key: string,
	) {
		return this.get(backend).setAuth(clientId, providerId, key);
	}

	command(
		clientId: string,
		backend: AiBackend,
		sessionId: string,
		command: string,
		args: string,
	) {
		return this.get(backend).command(clientId, sessionId, command, args);
	}
	revert(
		clientId: string,
		backend: AiBackend,
		sessionId: string,
		messageId: string,
	) {
		return this.get(backend).revert(clientId, sessionId, messageId);
	}
	unrevert(clientId: string, backend: AiBackend, sessionId: string) {
		return this.get(backend).unrevert(clientId, sessionId);
	}
	share(clientId: string, backend: AiBackend, sessionId: string) {
		return this.get(backend).share(clientId, sessionId);
	}
	permissionReply(
		clientId: string,
		backend: AiBackend,
		sessionId: string,
		permissionId: string,
		response: "once" | "always" | "reject",
	) {
		return this.get(backend).permissionReply(
			clientId,
			sessionId,
			permissionId,
			response,
		);
	}
	questionReply(
		clientId: string,
		backend: AiBackend,
		sessionId: string,
		questionId: string,
		answers: string[][],
	) {
		const provider = this.get(backend);
		if (!provider.questionReply)
			throw new Error(`Backend "${backend}" does not support question replies`);
		return provider.questionReply(clientId, sessionId, questionId, answers);
	}
	questionReject(
		clientId: string,
		backend: AiBackend,
		sessionId: string,
		questionId: string,
	) {
		const provider = this.get(backend);
		if (!provider.questionReject)
			throw new Error(
				`Backend "${backend}" does not support question rejection`,
			);
		return provider.questionReject(clientId, sessionId, questionId);
	}
}

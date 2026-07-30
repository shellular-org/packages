import * as acp from "@agentclientprotocol/sdk";
import { nanoid } from "nanoid";

import { logger } from "@/logger";
import { PermissionNotFoundError } from "./errors";
import type { ElicitationRequestEvent, PermissionRequestEvent } from "./types";

/** True for an inbound `session/update` JSON-RPC notification. */
function isSessionUpdateNotification(message: unknown): boolean {
	return (
		typeof message === "object" &&
		message !== null &&
		"method" in message &&
		(message as { method?: unknown }).method ===
			acp.methods.client.session.update &&
		!("id" in message)
	);
}

interface PendingPermission {
	resolve: (response: acp.RequestPermissionResponse) => void;
	sessionId: string;
	params: acp.RequestPermissionRequest;
}

interface PendingElicitation {
	resolve: (response: acp.CreateElicitationResponse) => void;
	sessionId: string;
	params: acp.CreateElicitationRequest;
}

type SessionUpdateListener = (
	notification: acp.SessionNotification,
) => void | Promise<void>;
export type PermissionListener = (event: PermissionRequestEvent) => void;
export type ElicitationListener = (event: ElicitationRequestEvent) => void;

export class AcpClient {
	private pendingPermissions = new Map<string, PendingPermission>();
	private sessionUpdateListeners = new Map<
		acp.SessionId,
		Set<SessionUpdateListener>
	>();
	private anySessionUpdateListeners = new Set<SessionUpdateListener>();
	private permissionListeners = new Map<string, PermissionListener>();
	private sessionsWithPendingPermissions = new Map<string, string>();
	private pendingElicitations = new Map<string, PendingElicitation>();
	private elicitationListeners = new Map<string, ElicitationListener>();
	private sessionsWithPendingElicitations = new Map<string, string>();
	// session/update notifications currently mid-dispatch, and who is waiting
	// for that count to reach zero. See `settled()`.
	private inFlightUpdates = 0;
	private idleWaiters: Array<() => void> = [];
	// Latest available_commands_update per session. Agents may send this after
	// responding to session/load (it is session state, not replayed history),
	// so it cannot be recovered by scanning a load's returned updates — see
	// `getAvailableCommands`.
	private availableCommands = new Map<acp.SessionId, unknown[]>();

	addSessionUpdateListener(
		sessionId: acp.SessionId,
		listener: SessionUpdateListener,
	) {
		let listeners = this.sessionUpdateListeners.get(sessionId);
		if (!listeners) {
			listeners = new Set();
			this.sessionUpdateListeners.set(sessionId, listeners);
		}

		listeners.add(listener);
	}

	removeSessionUpdateListener(
		sessionId: acp.SessionId,
		listener: SessionUpdateListener,
	) {
		const listeners = this.sessionUpdateListeners.get(sessionId);
		if (!listeners) return;
		listeners.delete(listener);
		if (listeners.size === 0) {
			this.sessionUpdateListeners.delete(sessionId);
		}
	}

	/**
	 * Subscribe to every session/update, regardless of session. This exists for
	 * subscribers that are installed before any session id is known and must
	 * span every session on the connection — currently the manager's status
	 * fan-out. Anything scoped to one conversation must use
	 * `addSessionUpdateListener`, which is the only session-bound form.
	 */
	onSessionUpdate(listener: SessionUpdateListener): () => void {
		this.anySessionUpdateListeners.add(listener);
		return () => this.anySessionUpdateListeners.delete(listener);
	}

	onPermission(clientId: string, listener: PermissionListener): () => void {
		this.permissionListeners.set(clientId, listener);
		return () => this.permissionListeners.delete(clientId);
	}

	requestPermission(
		params: acp.RequestPermissionRequest,
		permissionId?: string,
		clientId?: string,
	): Promise<acp.RequestPermissionResponse> {
		permissionId = permissionId || nanoid();

		return new Promise((resolve) => {
			this.pendingPermissions.set(permissionId, {
				resolve,
				sessionId: params.sessionId,
				params,
			});
			this.sessionsWithPendingPermissions.set(params.sessionId, permissionId);
			this.emitPermissionRequest(permissionId, params, clientId);
		});
	}

	replyPermission(
		permissionId: string,
		optionId: string,
	): acp.RequestPermissionResponse {
		const pending = this.pendingPermissions.get(permissionId);
		if (!pending) throw new PermissionNotFoundError(permissionId);

		const option = pending.params.options.find(
			(candidate) => candidate.optionId === optionId,
		);
		if (!option) {
			throw new Error(
				`Permission option "${optionId}" was not found for request "${permissionId}"`,
			);
		}
		const response: acp.RequestPermissionResponse = {
			outcome: {
				outcome: "selected",
				optionId,
			},
		};
		this.pendingPermissions.delete(permissionId);
		this.sessionsWithPendingPermissions.delete(pending.sessionId);
		pending.resolve(response);
		return response;
	}

	requestPendingPermission(sessionId: string, clientId?: string) {
		const permissionId = this.sessionsWithPendingPermissions.get(sessionId);
		if (!permissionId) return false;
		const permission = this.pendingPermissions.get(permissionId);
		if (!permission) return false;
		this.emitPermissionRequest(permissionId, permission.params, clientId);
		return true;
	}

	hasPendingPermission(sessionId: string) {
		const permissionId = this.sessionsWithPendingPermissions.get(sessionId);
		if (!permissionId) return false;
		const permission = this.pendingPermissions.get(permissionId);
		if (!permission) return false;
		return true;
	}

	requestPendingPermissions(clientId: string) {
		for (const [
			permissionId,
			permission,
		] of this.pendingPermissions.entries()) {
			this.emitPermissionRequest(permissionId, permission.params, clientId);
		}
	}

	cancelSessionPermissions(sessionId: string) {
		for (const [permissionId, pending] of this.pendingPermissions) {
			if (pending.sessionId !== sessionId) continue;
			this.pendingPermissions.delete(permissionId);
			pending.resolve({ outcome: { outcome: "cancelled" } });
		}
	}

	onElicitation(clientId: string, listener: ElicitationListener): () => void {
		this.elicitationListeners.set(clientId, listener);
		return () => this.elicitationListeners.delete(clientId);
	}

	/**
	 * Handle an ACP `elicitation/create` request: park it until a UI answers via
	 * replyElicitation, mirroring the permission flow. The promise resolution IS
	 * the JSON-RPC response, so an unanswered elicitation blocks the agent's
	 * turn exactly like an unanswered permission.
	 */
	requestElicitation(
		params: acp.CreateElicitationRequest,
		clientId?: string,
	): Promise<acp.CreateElicitationResponse> {
		// URL-mode elicitations carry their own id (the agent correlates the
		// later elicitation/complete notification with it); form-mode ones don't.
		const elicitationId =
			("elicitationId" in params && typeof params.elicitationId === "string"
				? params.elicitationId
				: undefined) ?? nanoid();
		// Elicitations are session-scoped or request-scoped; only session-scoped
		// ones can be routed to a chat UI.
		const sessionId =
			"sessionId" in params && typeof params.sessionId === "string"
				? params.sessionId
				: "";

		return new Promise((resolve) => {
			this.pendingElicitations.set(elicitationId, {
				resolve,
				sessionId,
				params,
			});
			if (sessionId) {
				this.sessionsWithPendingElicitations.set(sessionId, elicitationId);
			}
			this.emitElicitationRequest(elicitationId, params, clientId);
		});
	}

	replyElicitation(
		elicitationId: string,
		response: acp.CreateElicitationResponse,
	): acp.CreateElicitationResponse {
		const pending = this.pendingElicitations.get(elicitationId);
		if (!pending) {
			throw new Error(`Elicitation "${elicitationId}" was not found`);
		}
		this.pendingElicitations.delete(elicitationId);
		if (pending.sessionId) {
			this.sessionsWithPendingElicitations.delete(pending.sessionId);
		}
		pending.resolve(response);
		return response;
	}

	requestPendingElicitation(sessionId: string, clientId?: string) {
		const elicitationId = this.sessionsWithPendingElicitations.get(sessionId);
		if (!elicitationId) return false;
		const pending = this.pendingElicitations.get(elicitationId);
		if (!pending) return false;
		this.emitElicitationRequest(elicitationId, pending.params, clientId);
		return true;
	}

	cancelSessionElicitations(sessionId: string) {
		for (const [elicitationId, pending] of this.pendingElicitations) {
			if (pending.sessionId !== sessionId) continue;
			this.pendingElicitations.delete(elicitationId);
			this.sessionsWithPendingElicitations.delete(sessionId);
			pending.resolve({ action: "cancel" });
		}
	}

	/**
	 * A url-mode elicitation finished server-side (`elicitation/complete`).
	 * There's no pending promise to resolve here — the create request was
	 * already answered when the user opened the URL — so just fan out to
	 * listeners so UIs can drop their "waiting" cards.
	 */
	completeElicitation(params: acp.CompleteElicitationNotification) {
		for (const listener of this.elicitationCompleteListeners) {
			try {
				listener(params);
			} catch (err) {
				logger.error("Elicitation complete listener failed:", err);
			}
		}
	}

	onElicitationComplete(
		listener: (params: acp.CompleteElicitationNotification) => void,
	): () => void {
		this.elicitationCompleteListeners.add(listener);
		return () => this.elicitationCompleteListeners.delete(listener);
	}

	private elicitationCompleteListeners = new Set<
		(params: acp.CompleteElicitationNotification) => void
	>();

	private emitElicitationRequest(
		elicitationId: string,
		params: acp.CreateElicitationRequest,
		clientId?: string,
	) {
		const event: ElicitationRequestEvent = {
			id: elicitationId,
			sessionId:
				"sessionId" in params && typeof params.sessionId === "string"
					? params.sessionId
					: undefined,
			raw: params,
		};
		for (const [key, listener] of this.elicitationListeners.entries()) {
			if (!clientId || clientId === key) {
				listener(event);
			}
		}
	}

	private emitPermissionRequest(
		permissionId: string,
		params: acp.RequestPermissionRequest,
		clientId?: string,
	) {
		const event: PermissionRequestEvent = {
			id: permissionId,
			sessionId: params.sessionId,
			toolCall: params.toolCall,
			options: params.options,
			raw: params,
		};

		for (const [key, listener] of this.permissionListeners.entries()) {
			if (!clientId || clientId === key) {
				listener(event);
			}
		}
	}

	async sessionUpdate(params: acp.SessionNotification): Promise<void> {
		// The transport counted this notification when it was read off the wire
		// (see `observeStream`); this call is its dispatch, so release it here.
		try {
			const update = params.update;
			if (update.sessionUpdate === "available_commands_update") {
				this.availableCommands.set(params.sessionId, update.availableCommands);
			}
			for (const listener of this.anySessionUpdateListeners) {
				this.dispatchSessionUpdate(listener, params);
			}
			const listeners = this.sessionUpdateListeners.get(params.sessionId);
			if (listeners) {
				for (const listener of listeners) {
					this.dispatchSessionUpdate(listener, params);
				}
			}
		} finally {
			this.releaseUpdate();
		}
	}

	/** Drop one in-flight notification, waking `settled()` waiters at zero. */
	private releaseUpdate() {
		this.inFlightUpdates -= 1;
		if (this.inFlightUpdates > 0) return;
		const waiters = this.idleWaiters;
		this.idleWaiters = [];
		for (const resolve of waiters) resolve();
	}

	/**
	 * Wrap the agent's transport so session/update notifications are counted as
	 * they are *read off the wire*, before the SDK dispatches them.
	 *
	 * This has to happen at the transport rather than in `sessionUpdate()`.
	 * The SDK routes notifications through a fire-and-forget async handler
	 * chain (`void processIncomingMessage(...)`, one `await` per registered
	 * handler) while resolving responses synchronously with no chain at all.
	 * So when a response's promise resolves, an earlier notification may not
	 * have reached our handler yet — counting on arrival at the handler would
	 * miss exactly the notifications we need to wait for, and would silently
	 * miss more of them as handlers are added.
	 */
	observeStream(stream: acp.Stream): acp.Stream {
		const readable = stream.readable.pipeThrough(
			new TransformStream<acp.AnyMessage, acp.AnyMessage>({
				transform: (message, controller) => {
					if (isSessionUpdateNotification(message)) {
						this.inFlightUpdates += 1;
					}
					controller.enqueue(message);
				},
			}),
		);
		return { readable, writable: stream.writable };
	}

	/**
	 * Latest slash commands the agent advertised for a session, or undefined if
	 * it never sent any. Tracked continuously because `available_commands_update`
	 * is session state the agent may (and Claude Code does) send *after* the
	 * session/load response, putting it outside that call's replay window.
	 */
	getAvailableCommands(sessionId: acp.SessionId): unknown[] | undefined {
		return this.availableCommands.get(sessionId);
	}

	/**
	 * Resolve once every session/update notification read off the wire has
	 * finished dispatching. Callers that must observe the complete notification
	 * stream — notably `session/load`, whose replay ends only when the response
	 * arrives — await this instead of treating the response as the end.
	 */
	settled(): Promise<void> {
		if (this.inFlightUpdates === 0) return Promise.resolve();
		return new Promise((resolve) => this.idleWaiters.push(resolve));
	}

	private dispatchSessionUpdate(
		listener: SessionUpdateListener,
		params: acp.SessionNotification,
	) {
		try {
			const result = listener(params);
			if (result instanceof Promise) {
				// An async listener is still doing this notification's work, so
				// keep it counted until it resolves; otherwise `settled()` could
				// report idle while a listener is mid-update.
				this.inFlightUpdates += 1;
				result
					.catch((err) => {
						logger.error("Session update listener failed:", err);
					})
					.finally(() => this.releaseUpdate());
			}
		} catch (err) {
			logger.error("Session update listener failed:", err);
		}
	}
}

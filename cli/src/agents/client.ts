import type * as acp from "@agentclientprotocol/sdk";
import { nanoid } from "nanoid";

import { logger } from "@/logger";
import { PermissionNotFoundError } from "./errors";
import type { PermissionRequestEvent } from "./types";

interface PendingPermission {
	resolve: (response: acp.RequestPermissionResponse) => void;
	sessionId: string;
	params: acp.RequestPermissionRequest;
}

type SessionUpdateListener = (
	notification: acp.SessionNotification,
) => void | Promise<void>;
export type PermissionListener = (event: PermissionRequestEvent) => void;

export class AcpClient {
	private pendingPermissions = new Map<string, PendingPermission>();
	private sessionUpdateListeners = new Map<
		acp.SessionId,
		Set<SessionUpdateListener>
	>();
	private anySessionUpdateListeners = new Set<SessionUpdateListener>();
	private permissionListeners = new Map<string, PermissionListener>();
	private sessionsWithPendingPermissions = new Map<string, string>();

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

	addAnySessionUpdateListener(listener: SessionUpdateListener) {
		this.anySessionUpdateListeners.add(listener);
	}

	removeAnySessionUpdateListener(listener: SessionUpdateListener) {
		this.anySessionUpdateListeners.delete(listener);
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
		for (const listener of this.anySessionUpdateListeners) {
			this.dispatchSessionUpdate(listener, params);
		}
		const listeners = this.sessionUpdateListeners.get(params.sessionId);
		if (listeners) {
			for (const listener of listeners) {
				this.dispatchSessionUpdate(listener, params);
			}
		}
	}

	private dispatchSessionUpdate(
		listener: SessionUpdateListener,
		params: acp.SessionNotification,
	) {
		try {
			const result = listener(params);
			if (result instanceof Promise) {
				result.catch((err) => {
					logger.error("Session update listener failed:", err);
				});
			}
		} catch (err) {
			logger.error("Session update listener failed:", err);
		}
	}
}

import type * as acp from "@agentclientprotocol/sdk";
import { nanoid } from "nanoid";

interface PendingPermission {
	resolve: (response: acp.RequestPermissionResponse) => void;
	reject: (error: Error) => void;
	sessionId: string;
}

type SessionUpdateListener = (notification: acp.SessionNotification) => void;

/**
 * Implements the ACP `Client` interface, handling agent-initiated requests
 * (e.g. permission prompts) and dispatching `session/update` notifications
 * to registered listeners.
 */
export class AcpClient implements acp.Client {
	private pendingPermissions = new Map<string, PendingPermission>();
	private sessionUpdateListeners = new Map<
		acp.SessionId,
		Set<SessionUpdateListener>
	>();

	/**
	 * Registers a listener for `session/update` notifications on a specific session.
	 * Multiple listeners per session are supported.
	 */
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

	/**
	 * Removes a previously registered session update listener.
	 * Cleans up the session entry from the map when no listeners remain.
	 */
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

	requestPermission(
		params: acp.RequestPermissionRequest,
	): Promise<acp.RequestPermissionResponse> {
		const permissionId = nanoid();

		return new Promise((resolve, reject) => {
			this.pendingPermissions.set(permissionId, {
				resolve,
				reject,
				sessionId: params.sessionId,
			});
		});
	}

	async sessionUpdate(params: acp.SessionNotification): Promise<void> {
		const listeners = this.sessionUpdateListeners.get(params.sessionId);
		if (listeners) {
			for (const listener of listeners) {
				listener(params);
			}
		}
	}
}

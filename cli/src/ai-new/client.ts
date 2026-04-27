import type * as acp from "@agentclientprotocol/sdk";
import { nanoid } from "nanoid";

import { PermissionNotFoundError } from "./errors";
import type { PermissionReply, PermissionRequestEvent } from "./types";

interface PendingPermission {
	resolve: (response: acp.RequestPermissionResponse) => void;
	sessionId: string;
	params: acp.RequestPermissionRequest;
}

type SessionUpdateListener = (notification: acp.SessionNotification) => void;
type PermissionListener = (event: PermissionRequestEvent) => void;

export class AcpClient implements acp.Client {
	private pendingPermissions = new Map<string, PendingPermission>();
	private sessionUpdateListeners = new Map<
		acp.SessionId,
		Set<SessionUpdateListener>
	>();
	private permissionListeners = new Set<PermissionListener>();

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

	onPermission(listener: PermissionListener): () => void {
		this.permissionListeners.add(listener);
		return () => this.permissionListeners.delete(listener);
	}

	requestPermission(
		params: acp.RequestPermissionRequest,
	): Promise<acp.RequestPermissionResponse> {
		const permissionId = nanoid();

		return new Promise((resolve) => {
			this.pendingPermissions.set(permissionId, {
				resolve,
				sessionId: params.sessionId,
				params,
			});

			const event: PermissionRequestEvent = {
				id: permissionId,
				sessionId: params.sessionId,
				toolCall: params.toolCall,
				options: params.options,
				raw: params,
			};

			for (const listener of this.permissionListeners) {
				listener(event);
			}
		});
	}

	replyPermission(
		permissionId: string,
		reply: PermissionReply,
	): acp.RequestPermissionResponse {
		const pending = this.pendingPermissions.get(permissionId);
		if (!pending) throw new PermissionNotFoundError(permissionId);

		const option = this.pickOption(pending.params.options, reply);
		const response: acp.RequestPermissionResponse = {
			outcome: {
				outcome: "selected",
				optionId: option.optionId,
			},
		};
		this.pendingPermissions.delete(permissionId);
		pending.resolve(response);
		return response;
	}

	cancelSessionPermissions(sessionId: string) {
		for (const [permissionId, pending] of this.pendingPermissions) {
			if (pending.sessionId !== sessionId) continue;
			this.pendingPermissions.delete(permissionId);
			pending.resolve({ outcome: { outcome: "cancelled" } });
		}
	}

	async sessionUpdate(params: acp.SessionNotification): Promise<void> {
		const listeners = this.sessionUpdateListeners.get(params.sessionId);
		if (listeners) {
			for (const listener of listeners) {
				listener(params);
			}
		}
	}

	private pickOption(
		options: acp.PermissionOption[],
		reply: PermissionReply,
	): acp.PermissionOption {
		const preferredKinds: acp.PermissionOptionKind[] =
			reply === "once"
				? ["allow_once", "allow_always"]
				: reply === "always"
					? ["allow_always", "allow_once"]
					: ["reject_once", "reject_always"];

		for (const kind of preferredKinds) {
			const option = options.find((candidate) => candidate.kind === kind);
			if (option) return option;
		}

		const fallback = options[0];
		if (!fallback) {
			throw new Error("Permission request did not include any options");
		}
		return fallback;
	}
}

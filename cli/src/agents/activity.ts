import type {
	AgentSessionActivity,
	AgentSessionActivityState,
	AiBackend,
	AiEvent,
	AiSession,
	AiSessionRuntimeState,
} from "@shellular/protocol";

interface ActivityListOptions {
	limit?: number;
	includeDoneSince?: number;
}

interface SessionMetadata {
	clientId?: string;
	title?: string;
	workspacePath?: string;
	model?: string;
}

interface ActivityPatch extends SessionMetadata {
	hostId: string;
	agentId: AiBackend;
	sessionId: string;
	state?: AgentSessionActivityState;
	headline?: string;
	detail?: string;
	permissionId?: string;
	permissionKind?: string;
	endedAt?: number;
	unread?: boolean;
}

type ActivityListener = (activity: AgentSessionActivity) => void;

const DONE_STATES = new Set<AgentSessionActivityState>([
	"done",
	"failed",
	"cancelled",
	"idle",
]);

export class AgentActivityStore {
	private activities = new Map<string, AgentSessionActivity>();
	private metadata = new Map<string, SessionMetadata>();
	private listeners = new Set<ActivityListener>();
	private eventSeq = 0;

	subscribe(listener: ActivityListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	list(options: ActivityListOptions = {}): AgentSessionActivity[] {
		const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
		return [...this.activities.values()]
			.filter((activity) => {
				if (!options.includeDoneSince) return true;
				if (!DONE_STATES.has(activity.state)) return true;
				return activity.updatedAt >= options.includeDoneSince;
			})
			.sort(compareActivity)
			.slice(0, limit);
	}

	getSessionRuntimeState(
		agentId: AiBackend,
		sessionId: string,
	): AiSessionRuntimeState {
		const activity = this.activities.get(this.key(agentId, sessionId));
		return activity ? activityStateToRuntimeState(activity.state) : "idle";
	}

	withRuntimeState<T extends { id?: string }>(
		agentId: AiBackend,
		session: T,
	): T & { runtimeState: AiSessionRuntimeState } {
		return {
			...session,
			runtimeState: session.id
				? this.getSessionRuntimeState(agentId, session.id)
				: "idle",
		};
	}

	rememberSession(
		hostId: string,
		agentId: AiBackend,
		session:
			| AiSession
			| { id?: string; title?: string; workspacePath?: string; model?: string },
		clientId?: string,
	) {
		if (!session.id) return;
		const key = this.key(agentId, session.id);
		const previous = this.metadata.get(key);
		const metadata = {
			clientId: clientId ?? previous?.clientId,
			title: usableTitle(session.title) ?? previous?.title,
			workspacePath: session.workspacePath ?? previous?.workspacePath,
			model: session.model ?? previous?.model,
		};
		const changed =
			metadata.clientId !== previous?.clientId ||
			metadata.title !== previous?.title ||
			metadata.workspacePath !== previous?.workspacePath ||
			metadata.model !== previous?.model;
		this.metadata.set(key, metadata);
		const existing = this.activities.get(key);
		if (!existing || !changed) return;
		this.upsert({
			hostId,
			agentId,
			sessionId: session.id,
			...metadata,
		});
	}

	recordPromptStart(options: {
		hostId: string;
		clientId: string;
		agentId: AiBackend;
		sessionId: string;
	}) {
		this.upsert({
			...options,
			state: "running",
			headline: "Agent is working",
			detail: "Processing your request",
			endedAt: undefined,
			unread: true,
		});
	}

	recordCancel(options: {
		hostId: string;
		clientId: string;
		agentId: AiBackend;
		sessionId: string;
	}) {
		this.upsert({
			...options,
			state: "cancelled",
			headline: "Agent stopped",
			detail: "The run was cancelled",
			endedAt: Date.now(),
		});
	}

	recordEvent(
		hostId: string,
		clientId: string,
		agentId: AiBackend,
		event: AiEvent,
	) {
		const sessionId = readString(event.properties.sessionId);
		if (!sessionId) return;

		const base = { hostId, clientId, agentId, sessionId };
		switch (event.type) {
			case "token":
			case "message":
				this.upsert({
					...base,
					...metadataFromStatus(event),
					state: "running",
					headline: "Agent is working",
					detail: statusDetail(event),
					endedAt: undefined,
					unread: true,
				});
				break;
			case "session.status": {
				const metadata = metadataFromStatus(event);
				this.rememberSession(
					hostId,
					agentId,
					{ id: sessionId, ...metadata },
					clientId,
				);
				const existing = this.activities.get(this.key(agentId, sessionId));
				if (existing && isStreamingActivity(existing.state)) {
					this.upsert({
						...base,
						...metadata,
						detail: statusDetail(event) ?? existing.detail,
					});
				}
				break;
			}
			case "permission.updated":
				this.upsert({
					...base,
					state: "waiting_for_permission",
					headline: "Needs permission",
					detail: readString(event.properties.title) ?? "Review required",
					permissionId: readString(event.properties.id),
					permissionKind: readString(event.properties.kind),
					endedAt: undefined,
					unread: true,
				});
				break;
			case "end":
				this.upsert({
					...base,
					state: "done",
					headline: "Agent finished",
					detail: stopReasonDetail(event),
					endedAt: Date.now(),
				});
				break;
			case "cancelled":
				this.recordCancel(base);
				break;
			case "error":
			case "prompt_error":
				this.upsert({
					...base,
					state: "failed",
					headline: "Agent failed",
					detail: readString(event.properties.error) ?? "Run failed",
					endedAt: Date.now(),
					unread: true,
				});
				break;
		}
	}

	private upsert(patch: ActivityPatch) {
		const key = this.key(patch.agentId, patch.sessionId);
		const existing = this.activities.get(key);
		const metadata = this.metadata.get(key);
		const now = Date.now();
		const state = patch.state ?? existing?.state ?? "idle";
		const next: AgentSessionActivity = {
			id: existing?.id ?? `${patch.hostId}:${patch.agentId}:${patch.sessionId}`,
			hostId: patch.hostId,
			clientId: patch.clientId ?? metadata?.clientId ?? existing?.clientId,
			agentId: patch.agentId,
			sessionId: patch.sessionId,
			title: patch.title ?? metadata?.title ?? existing?.title,
			workspacePath:
				patch.workspacePath ??
				metadata?.workspacePath ??
				existing?.workspacePath,
			model: patch.model ?? metadata?.model ?? existing?.model,
			state,
			headline: patch.headline ?? existing?.headline ?? defaultHeadline(state),
			detail: patch.detail ?? existing?.detail,
			permissionId:
				patch.permissionId ??
				(state === "waiting_for_permission"
					? existing?.permissionId
					: undefined),
			permissionKind:
				patch.permissionKind ??
				(state === "waiting_for_permission"
					? existing?.permissionKind
					: undefined),
			startedAt: existing?.startedAt ?? (state === "running" ? now : undefined),
			updatedAt: now,
			endedAt:
				patch.endedAt ??
				existing?.endedAt ??
				(DONE_STATES.has(state) ? now : undefined),
			unread: patch.unread ?? existing?.unread ?? false,
			eventSeq: ++this.eventSeq,
			eventId: `${patch.hostId}:${patch.agentId}:${patch.sessionId}:${this.eventSeq}`,
		};
		this.activities.set(key, next);
		for (const listener of this.listeners) listener(next);
	}

	private key(agentId: string, sessionId: string) {
		return `${agentId}:${sessionId}`;
	}
}

function compareActivity(a: AgentSessionActivity, b: AgentSessionActivity) {
	const priority = statePriority(a.state) - statePriority(b.state);
	if (priority !== 0) return priority;
	return b.updatedAt - a.updatedAt;
}

function statePriority(state: AgentSessionActivityState) {
	switch (state) {
		case "waiting_for_permission":
			return 0;
		case "failed":
			return 1;
		case "running":
			return 2;
		case "done":
			return 3;
		case "cancelled":
			return 4;
		case "idle":
			return 5;
		default:
			return 6;
	}
}

function activityStateToRuntimeState(
	state: AgentSessionActivityState,
): AiSessionRuntimeState {
	switch (state) {
		case "running":
			return "streaming";
		case "waiting_for_permission":
			return "waiting_for_permission";
		case "failed":
			return "failed";
		case "cancelled":
			return "cancelled";
		case "done":
		case "idle":
			return "idle";
	}
}

function isStreamingActivity(state: AgentSessionActivityState) {
	return state === "running" || state === "waiting_for_permission";
}

function defaultHeadline(state: AgentSessionActivityState) {
	switch (state) {
		case "waiting_for_permission":
			return "Needs permission";
		case "running":
			return "Agent is working";
		case "done":
			return "Agent finished";
		case "failed":
			return "Agent failed";
		case "cancelled":
			return "Agent stopped";
		case "idle":
			return "Agent idle";
	}
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function usableTitle(value: unknown): string | undefined {
	const title = readString(value);
	if (!title) return undefined;
	const normalized = title.trim().toLowerCase();
	if (normalized === "new chat" || normalized === "untitled chat") {
		return undefined;
	}
	return title;
}

function metadataFromStatus(event: AiEvent): SessionMetadata {
	const update = event.properties.status as
		| {
				title?: unknown;
				name?: unknown;
				model?: unknown;
				modelId?: unknown;
				cwd?: unknown;
				workspacePath?: unknown;
				session?: {
					title?: unknown;
					model?: unknown;
					workspacePath?: unknown;
				};
		  }
		| undefined;
	return {
		title:
			usableTitle(update?.title) ??
			usableTitle(update?.name) ??
			usableTitle(update?.session?.title),
		model:
			readString(update?.model) ??
			readString(update?.modelId) ??
			readString(update?.session?.model),
		workspacePath:
			readString(update?.workspacePath) ??
			readString(update?.cwd) ??
			readString(update?.session?.workspacePath),
	};
}

function statusDetail(event: AiEvent) {
	const update = event.properties.status as
		| { sessionUpdate?: unknown }
		| undefined;
	const sessionUpdate = readString(update?.sessionUpdate);
	if (sessionUpdate === "available_commands_update") return "Updated commands";
	if (sessionUpdate === "config_option_update") return "Updated settings";
	if (sessionUpdate === "usage_update") return "Updated context";
	return undefined;
}

function stopReasonDetail(event: AiEvent) {
	const stopReason = readString(event.properties.stopReason);
	return stopReason ? `Stopped: ${stopReason}` : "Run completed";
}

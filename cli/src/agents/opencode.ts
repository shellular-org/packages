import crypto from "node:crypto";

import type * as acp from "@agentclientprotocol/sdk";
import {
	createOpencodeClient,
	createOpencodeServer,
} from "@opencode-ai/sdk/v2";
import { z } from "zod";

import { config } from "@/config";
import { BUILTIN_AGENT_DESCRIPTORS } from "./agents";
import { ACP } from "./base";
import { type AcpTranscriptOptions, acpSessionToAiSession } from "./events";
import {
	normalizeUserFileAttachmentReplayMessage,
	shouldSkipOpenCodeReadReplayContent,
} from "./replay-normalization";

const OpenCodeSessionSchema = z.object({
	id: z.string(),
	slug: z.string(),
	projectID: z.string(),
	directory: z.string(),
	title: z.string().optional(),
	version: z.string(),
	summary: z
		.object({
			additions: z.number().int(),
			deletions: z.number().int(),
			files: z.number().int(),
		})
		.optional(),
	time: z.object({
		created: z.number().int(),
		updated: z.number().int(),
	}),
	project: z
		.object({
			id: z.string(),
			worktree: z.string(),
		})
		.optional(),
});

const OpenCodeSessionListSchema = z.object({
	data: z.array(OpenCodeSessionSchema),
});

const OPENCODE_SESSION_PAGE_SIZE = 40;

/**
 * OpenCode ACP client with custom session listing using opencode sdk.
 *
 * OpenCode's ACP `session/list` does not yet return project-level metadata
 * (project ID, slug, summary stats) or accurate timestamps that the
 * Shellular UI depends on. Until the ACP endpoint gains parity, this class
 * overrides `listSessionPage()` to fetch sessions via the v2 HTTP
 * API (`@opencode-ai/sdk/v2`) and maps them into the standard
 * `acp.SessionInfo` shape.
 *
 * All other ACP methods (prompt, load, resume, etc.) go through the
 * standard stdio JSON-RPC connection as defined in the `ACP` base class.
 *
 * TODO: Remove the override once OpenCode's ACP `session/list` includes
 * project metadata and timestamps.
 */
export class OpenCode extends ACP {
	private ocClient: ReturnType<typeof createOpencodeClient> | null = null;
	private ocServer: Awaited<ReturnType<typeof createOpencodeServer>> | null =
		null;
	private ocAuthHeader: string | null = null;

	static create() {
		return new OpenCode();
	}

	constructor() {
		super(BUILTIN_AGENT_DESCRIPTORS.opencode);
		const opencodeUsername = config.NAME;
		const opencodePassword = crypto.randomBytes(32).toString("base64url");
		this.ocAuthHeader = `Basic ${Buffer.from(`${opencodeUsername}:${opencodePassword}`).toString("base64")}`;
	}

	protected override transcriptOptions(): AcpTranscriptOptions {
		return {
			shouldSkipUserReplayContent: shouldSkipOpenCodeReadReplayContent,
			normalizeUserReplayMessage: normalizeUserFileAttachmentReplayMessage,
		};
	}

	override async init(): Promise<acp.InitializeResponse> {
		const result = await super.init();
		if (!this.ocServer) {
			this.ocServer = await createOpencodeServer({
				hostname: "127.0.0.1",
				port: 0,
				timeout: 15000,
			});
			this.ocClient = createOpencodeClient({
				baseUrl: this.ocServer.url,
				headers: { Authorization: this.ocAuthHeader },
				directory: undefined,
			});
		}
		return result;
	}

	override async listSessionPage(
		params: acp.ListSessionsRequest = {},
	): Promise<acp.ListSessionsResponse> {
		await this.init();
		if (!this.ocClient) return super.listSessionPage(params);

		const cursor = Number.parseInt(params.cursor ?? "0", 10);
		const start = Number.isFinite(cursor) && cursor > 0 ? cursor : 0;

		const response = await this.ocClient.experimental.session.list({
			...(params.cwd ? { directory: params.cwd } : { roots: true }),
			start,
			limit: OPENCODE_SESSION_PAGE_SIZE,
		});
		const parsed = OpenCodeSessionListSchema.parse(response);

		const sessions = parsed.data.map((session): acp.SessionInfo => {
			const sessionInfo = {
				sessionId: session.id,
				cwd: session.directory,
				title: session.title,
				updatedAt: new Date(session.time.updated).toISOString(),
				_meta: {
					slug: session.slug,
					projectID: session.projectID,
					version: session.version,
					summary: session.summary,
					createdAt: new Date(session.time.created).toISOString(),
				},
			};
			return sessionInfo;
		});

		for (const session of sessions) {
			const normalized = acpSessionToAiSession(session);
			this.setSessionStore(session.sessionId, {
				session: normalized,
				messages: this.getMessages(session.sessionId),
			});
		}

		return {
			sessions,
			nextCursor:
				sessions.length === OPENCODE_SESSION_PAGE_SIZE
					? String(start + sessions.length)
					: undefined,
		};
	}

	override destroy() {
		super.destroy();
		this.ocAuthHeader = null;
		this.ocClient = null;
		if (this.ocServer) {
			this.ocServer.close();
			this.ocServer = null;
		}
	}
}

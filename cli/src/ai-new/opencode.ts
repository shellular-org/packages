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
import { acpSessionToAiSession } from "./events";

const descriptor = BUILTIN_AGENT_DESCRIPTORS.find(
	(agent) => agent.id === "opencode",
);

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

/**
 * OpenCode ACP client with custom session listing using opencode sdk.
 *
 * OpenCode's ACP `session/list` does not yet return project-level metadata
 * (project ID, slug, summary stats) or accurate timestamps that the
 * Shellular UI depends on. Until the ACP endpoint gains parity, this class
 * overrides `listSessions()` to fetch sessions via the v2 HTTP
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
		if (!descriptor) return null;
		return new OpenCode();
	}

	constructor() {
		if (!descriptor) throw new Error("OpenCode descriptor is missing");
		super(descriptor);
		const opencodeUsername = config.NAME;
		const opencodePassword = crypto.randomBytes(32).toString("base64url");
		this.ocAuthHeader = `Basic ${Buffer.from(`${opencodeUsername}:${opencodePassword}`).toString("base64")}`;
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

	override async listSessions(params: acp.ListSessionsRequest = {}) {
		await this.init();
		if (!this.ocClient) return super.listSessions(params);

		const response = await this.ocClient.experimental.session.list({
			...(params.cwd ? { directory: params.cwd } : { roots: true }),
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

		return sessions;
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

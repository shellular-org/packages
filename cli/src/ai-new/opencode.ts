import crypto from "node:crypto";

import type * as acp from "@agentclientprotocol/sdk";
import {
	createOpencodeClient,
	createOpencodeServer,
} from "@opencode-ai/sdk/v2";
import { z } from "zod";

import { config } from "@/config";
import { ACP, type AgentProcessConfig, type SpawnedAgent } from "./base";

export const ACP_OPENCODE: AgentProcessConfig = {
	name: "opencode",
	agentExec: "opencode",
	command: "opencode",
	args: ["acp"],
};

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
		created: z.number().int(), // unix ms
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
 * ACP client for the OpenCode agent.
 *
 * Extends the base {@link ACP} class with OpenCode-specific session listing
 * via the OpenCode REST API, which provides richer metadata than the
 * standard ACP `session/list` response.
 */
export class OpenCode extends ACP {
	private _ocClient: ReturnType<typeof createOpencodeClient> | null = null;
	private _ocServer: Awaited<ReturnType<typeof createOpencodeServer>> | null =
		null;
	private _ocAuthHeader: string | null = null;

	static create() {
		const spawned = ACP.spawnAgentProcess(ACP_OPENCODE);
		if (!spawned) {
			return null;
		}

		return new OpenCode(spawned);
	}

	constructor(spawnedAgent: SpawnedAgent) {
		super(spawnedAgent);
		const opencodeUsername = config.NAME;
		const opencodePassword = crypto.randomBytes(32).toString("base64url");
		this._ocAuthHeader = `Basic ${Buffer.from(`${opencodeUsername}:${opencodePassword}`).toString("base64")}`;
	}

	/**
	 * Initializes the ACP connection and starts a local OpenCode HTTP server
	 * used for REST API calls (e.g. session listing).
	 */
	override async init(): Promise<acp.InitializeResponse> {
		const initResult = await super.init();

		this._ocServer = await createOpencodeServer({
			hostname: "127.0.0.1",
			port: 0,
			timeout: 15000,
		});

		this._ocClient = createOpencodeClient({
			baseUrl: this._ocServer.url,
			headers: { Authorization: this._ocAuthHeader },
			directory: undefined,
		});

		return initResult;
	}

	private get ocClient() {
		if (!this._ocClient) {
			throw new Error("OpenCode client is not ready");
		}

		return this._ocClient;
	}

	/**
	 * Lists sessions via the OpenCode REST API instead of ACP `session/list`,
	 * returning richer metadata (slug, projectID, summary, timestamps).
	 */
	override async listSessions(params: acp.ListSessionsRequest) {
		const response = await this.ocClient.experimental.session.list({
			...(params.cwd ? { directory: params.cwd } : { roots: true }),
		});

		const parsed = OpenCodeSessionListSchema.parse(response);

		const result: acp.SessionInfo[] = parsed.data.map((session) => {
			const sessionInfo: acp.SessionInfo = {
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

		return result;
	}

	destroy() {
		super.destroy();
		this._ocAuthHeader = null;
		this._ocClient = null;
		if (this._ocServer) {
			this._ocServer.close();
			this._ocServer = null;
		}
	}
}

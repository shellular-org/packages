import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type * as acp from "@agentclientprotocol/sdk";
import {
	createOpencodeClient,
	createOpencodeServer,
} from "@opencode-ai/sdk/v2";
import { z } from "zod";

import { config } from "@/config";
import { logger } from "@/logger";
import { BUILTIN_AGENT_DESCRIPTORS } from "./agents";
import { ACP } from "./base";
import { type AcpTranscriptOptions, acpSessionToAiSession } from "./events";
import {
	normalizeUserFileAttachmentReplayMessage,
	shouldSkipOpenCodeReadReplayContent,
} from "./replay-normalization";

/** A discovered running OpenCode server and its password (if known). */
interface DiscoveredOpenCodeServer {
	url: string;
	password: string | null;
	/** True when we did not spawn this server and must not kill it on destroy. */
	external: true;
}

/** Handle for a server we spawned ourselves (SDK-provided close handle). */
interface SpawnedOpenCodeServer {
	url: string;
	password: string | null;
	external: false;
	close: () => void;
}

type OpenCodeServer = DiscoveredOpenCodeServer | SpawnedOpenCodeServer;

/** Probe whether an OpenCode HTTP server is alive at the given base URL. */
async function probeOpenCodeServer(url: string): Promise<boolean> {
	try {
		const response = await fetch(`${url}/api/info`, {
			signal: AbortSignal.timeout(2000),
		});
		// Any HTTP response (even 401) means a server is alive there.
		return response.status < 500;
	} catch {
		return false;
	}
}

/**
 * Detect an already-running OpenCode server (from a previous `opencode serve`
 * or `opencode serve --service`) and reuse it instead of spawning a fresh one.
 *
 * Resolution order:
 * 1. `OPENCODE_SERVER_URL` environment variable (explicit override).
 * 2. Probe the well-known default port (4096) on loopback.
 * 3. Read `~/.config/opencode/service.json` written by `opencode serve --service`.
 *
 * Returns the base URL and password (if known), otherwise null.
 */
async function discoverRunningOpenCodeServer(): Promise<DiscoveredOpenCodeServer | null> {
	const envUrl = process.env.OPENCODE_SERVER_URL;
	if (envUrl) {
		return { url: envUrl.replace(/\/+$/, ""), password: null, external: true };
	}

	// Probe the well-known default port used by `opencode serve` (v2).
	const defaultPort = Number(process.env.OPENCODE_PORT || 4096);
	const candidate = `http://127.0.0.1:${defaultPort}`;
	if (await probeOpenCodeServer(candidate)) {
		return { url: candidate, password: null, external: true };
	}

	// Read service.json written by `opencode serve --service`.
	const serviceConfigPath = path.join(
		os.homedir(),
		".config",
		"opencode",
		"service.json",
	);
	try {
		const raw = await fs.promises.readFile(serviceConfigPath, "utf8");
		const serviceConfig = JSON.parse(raw) as {
			hostname?: string;
			port?: number;
			password?: string;
		};
		if (serviceConfig?.port) {
			const hostname = serviceConfig.hostname || "127.0.0.1";
			const url = `http://${hostname === "0.0.0.0" ? "127.0.0.1" : hostname}:${serviceConfig.port}`;
			if (await probeOpenCodeServer(url)) {
				return {
					url,
					password: serviceConfig.password ?? null,
					external: true,
				};
			}
		}
	} catch {
		// No service.json or unreadable — continue with the spawn fallback.
	}

	return null;
}

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
		.nullable()
		.optional(),
});

// The SDK normally returns its field-style response wrapper, while some beta
// OpenCode/SDK combinations return the response body directly.
const OpenCodeSessionListSchema = z.union([
	z.object({ data: z.array(OpenCodeSessionSchema) }),
	z.array(OpenCodeSessionSchema),
]);

/**
 * Normalize an OpenCode v2 server session object into the v1 shape the
 * Shellular app expects (a v2→v1 adapter).
 *
 * v2 moves `directory` under `location`, drops `slug`/`version`, and adds
 * extra fields (agent, model, tokens, outcome) that the v1 schema ignores.
 * v1-shaped sessions are passed through unchanged, so this also works with
 * older servers that already speak the v1 shape.
 */
function normalizeOpenCodeSession(
	session: unknown,
	serverVersion: string,
): unknown {
	if (typeof session !== "object" || session === null) return session;
	const s = session as Record<string, unknown>;
	const location = s.location as Record<string, unknown> | undefined;
	const directory =
		typeof s.directory === "string"
			? s.directory
			: typeof location?.directory === "string"
				? location.directory
				: undefined;
	if (typeof directory !== "string") {
		return session;
	}

	const title = typeof s.title === "string" ? s.title : "";
	const slug =
		typeof s.slug === "string" && s.slug
			? s.slug
			: title
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, "-")
					.replace(/^-|-$/g, "") || s.id;

	return {
		...s,
		directory,
		slug,
		version: typeof s.version === "string" ? s.version : serverVersion,
		project: { id: s.projectID, worktree: directory },
	};
}

/**
 * Wrap a v2 session-list response into the v1 shape, given the server's
 * reported version. Returns the input unchanged for v1-shaped responses.
 */
function wrapOpenCodeSessionsV2ToV1(
	response: unknown,
	serverVersion: string,
): unknown {
	if (typeof response !== "object" || response === null) return response;
	const sessions = Array.isArray(response)
		? response
		: (response as Record<string, unknown>).data;
	if (!Array.isArray(sessions)) return response;

	const normalized = sessions.map((session) =>
		normalizeOpenCodeSession(session, serverVersion),
	);
	return Array.isArray(response)
		? normalized
		: { ...response, data: normalized };
}

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
	#ocClient: ReturnType<typeof createOpencodeClient> | null = null;
	private ocServer: OpenCodeServer | null = null;
	private ocAuthHeader: string | null = null;
	private ocServerVersion: string | null = null;

	static create() {
		return new OpenCode();
	}

	constructor() {
		super(BUILTIN_AGENT_DESCRIPTORS.opencode);
		// Default auth header (used when we spawn our own server or no password
		// is known). v2 servers generate a per-server password, so this is a
		// placeholder that gets replaced in `init()` when a server is
		// discovered or spawned with a known password.
		const opencodeUsername = config.NAME;
		const opencodePassword = crypto.randomBytes(32).toString("base64url");
		this.ocAuthHeader = `Basic ${Buffer.from(`${opencodeUsername}:${opencodePassword}`).toString("base64")}`;
	}

	private setAuthHeaderFor(password: string | null) {
		if (!password) {
			return;
		}
		this.ocAuthHeader = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
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
			// Prefer reusing an already-running OpenCode server.
			const discovered = await discoverRunningOpenCodeServer();
			if (discovered) {
				logger.log(`reusing running opencode server at ${discovered.url}`);
				this.ocServer = discovered;
				this.setAuthHeaderFor(discovered.password);
			} else {
				const spawned = await createOpencodeServer({
					hostname: "127.0.0.1",
					port: 0,
					timeout: 15000,
				});
				this.ocServer = {
					url: spawned.url,
					password: null,
					external: false,
					close: spawned.close,
				};
			}

			this.#ocClient = createOpencodeClient({
				baseUrl: this.ocServer.url,
				headers: { Authorization: this.ocAuthHeader },
				directory: undefined,
			});

			// Ask the server for its version (used by the v2→v1 session
			// wrapper below). Best-effort — falls back to a placeholder.
			this.ocServerVersion = await this.fetchServerVersion();
		}

		return result;
	}

	private async fetchServerVersion(): Promise<string | null> {
		try {
			const response = await fetch(`${this.ocServer?.url}/api/info`, {
				headers: { Authorization: this.ocAuthHeader ?? "" },
				signal: AbortSignal.timeout(2000),
			});
			if (!response.ok) return null;
			const info = (await response.json()) as { version?: string };
			return typeof info.version === "string" ? info.version : null;
		} catch {
			return null;
		}
	}

	/**
	 * Fetch the session list directly from the v2 HTTP API (/api/session).
	 * The SDK's experimental.session.list points at /experimental/session,
	 * which OpenCode v2.x serves as the web UI (HTML), not JSON.
	 */
	private async fetchSessionsViaHttp(): Promise<{ data: unknown[] }> {
		if (!this.ocServer?.url) {
			throw new Error("OpenCode server not initialized");
		}

		const response = await fetch(`${this.ocServer.url}/api/session`, {
			headers: { Authorization: this.ocAuthHeader ?? "" },
			signal: AbortSignal.timeout(10000),
		});
		if (!response.ok) {
			throw new Error(`OpenCode session list failed: HTTP ${response.status}`);
		}
		const body = (await response.json()) as { data?: unknown[] };
		if (!Array.isArray(body.data)) {
			throw new Error("OpenCode session list returned unexpected shape");
		}
		return { data: body.data };
	}

	get ocClient() {
		if (!this.#ocClient) {
			throw new Error("OpenCode client not initialized");
		}

		return this.#ocClient;
	}

	override async listSessionPage(
		params: acp.ListSessionsRequest = {},
	): Promise<acp.ListSessionsResponse> {
		await this.init();

		const response = await this.ocClient.experimental.session
			.list({
				...(params.cwd ? { directory: params.cwd } : { roots: true }),
			})
			.catch(async () => {
				// OpenCode v2.1.4 serves the experimental session list at
				// /api/session; the SDK's /experimental/session path returns the
				// web UI (HTML), so fall back to the direct HTTP API.
				return await this.fetchSessionsViaHttp();
			});
		const wrapped = wrapOpenCodeSessionsV2ToV1(
			response,
			this.ocServerVersion ?? "2.0.0",
		);
		const parsed = OpenCodeSessionListSchema.parse(wrapped);
		const openCodeSessions = Array.isArray(parsed) ? parsed : parsed.data;

		const sessions = openCodeSessions.map((session): acp.SessionInfo => {
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
			nextCursor: undefined,
		};
	}

	override destroy() {
		super.destroy();
		this.ocAuthHeader = null;
		this.#ocClient = null;
		if (this.ocServer) {
			if (!this.ocServer.external) {
				// Only kill servers we spawned ourselves.
				this.ocServer.close();
			}
			this.ocServer = null;
		}
	}
}

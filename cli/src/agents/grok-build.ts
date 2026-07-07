import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type * as acp from "@agentclientprotocol/sdk";
import Database from "better-sqlite3";

import { logger } from "@/logger";
import { BUILTIN_AGENT_DESCRIPTORS } from "./agents";
import { ACP } from "./base";

/** Path to the shared session index Grok maintains for its search feature. */
export function grokSessionSearchDbPath(): string {
	return path.join(os.homedir(), ".grok", "sessions", "session_search.sqlite");
}

/**
 * A row of the `session_docs` table in Grok's `session_search.sqlite`. Grok
 * indexes every session here for its search feature; the columns we care about
 * are the id, the launch directory, the last-updated time, and the title.
 */
interface SessionDocRow {
	session_id: string;
	cwd: string;
	updated_at: number;
	title: string | null;
}

/**
 * ACP client for Grok Build CLI.
 *
 * Grok Build exposes ACP via `grok agent stdio`.
 * See: https://x.ai/cli
 *
 * Grok Build does not advertise the ACP `session/list` capability, so the base
 * class's session listing would throw `UnsupportedCapabilityError`. Rather than
 * shelling out to `grok sessions list` (slow, and its human-readable table omits
 * the working directory that `session/load` needs), we read Grok's own session
 * index directly: `~/.grok/sessions/session_search.sqlite`. It stores the
 * session id, launch `cwd`, `updated_at`, and title for every session, which is
 * exactly the shape ACP's `SessionInfo` wants — and it carries the `cwd`, which
 * is required to load a session back.
 */
export class GrokBuild extends ACP {
	static create() {
		return new GrokBuild(BUILTIN_AGENT_DESCRIPTORS["grok-build"]);
	}

	override async listSessions(
		params: acp.ListSessionsRequest = {},
	): Promise<acp.SessionInfo[]> {
		return this.listSessionsFromDb(params);
	}

	override async listSessionPage(
		params: acp.ListSessionsRequest = {},
	): Promise<acp.ListSessionsResponse> {
		// The sqlite index isn't paginated; return everything in one page.
		if (params.cursor) {
			return { sessions: [], nextCursor: undefined };
		}
		const sessions = await this.listSessionsFromDb(params);
		return { sessions, nextCursor: undefined };
	}

	private async listSessionsFromDb(
		params: acp.ListSessionsRequest,
	): Promise<acp.SessionInfo[]> {
		return readGrokSessions(
			grokSessionSearchDbPath(),
			params.cwd ? path.resolve(params.cwd) : undefined,
			this.id,
		);
	}
}

/**
 * Read Grok sessions out of the `session_search.sqlite` index.
 *
 * When `cwd` is given, only sessions launched from that directory are returned
 * (mirroring ACP's `ListSessionsRequest.cwd` filter). Sessions are returned
 * most-recently-updated first. If the database file doesn't exist yet (the user
 * has never run Grok, or is on an older version) we return no sessions rather
 * than erroring — there is simply nothing to list.
 */
export function readGrokSessions(
	dbPath: string,
	cwd: string | undefined,
	agentId = "grok-build",
): acp.SessionInfo[] {
	if (!existsSync(dbPath)) return [];

	let db: Database.Database | undefined;
	try {
		// readonly avoids taking a write lock on a DB Grok owns; fileMustExist so a
		// missing file (racing the existsSync above) throws instead of creating an
		// empty DB we'd then leave behind.
		db = new Database(dbPath, { readonly: true, fileMustExist: true });
		const rows = cwd
			? (db
					.prepare(
						"SELECT session_id, cwd, updated_at, title FROM session_docs WHERE cwd = ? ORDER BY updated_at DESC",
					)
					.all(cwd) as SessionDocRow[])
			: (db
					.prepare(
						"SELECT session_id, cwd, updated_at, title FROM session_docs ORDER BY updated_at DESC",
					)
					.all() as SessionDocRow[]);

		return rows
			.filter((row) => row.session_id && row.cwd)
			.map((row) => {
				const title = row.title?.trim();
				const session: acp.SessionInfo = {
					sessionId: row.session_id,
					cwd: row.cwd,
					updatedAt: toIsoTimestamp(row.updated_at),
				};
				if (title) session.title = title;
				return session;
			});
	} catch (err) {
		logger.warn(
			`ACP ${agentId}: failed reading Grok session index at ${dbPath}`,
			err instanceof Error ? err.message : String(err),
		);
		return [];
	} finally {
		db?.close();
	}
}

/**
 * Convert Grok's `updated_at` (unix seconds) to an ISO 8601 timestamp. Returns
 * undefined for a missing/invalid value so callers can omit `updatedAt`.
 */
function toIsoTimestamp(seconds: number): string | undefined {
	if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
		return undefined;
	}
	return new Date(seconds * 1000).toISOString();
}

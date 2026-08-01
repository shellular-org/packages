import type {
	AcpAiSession,
	AcpMessage,
	AiSessionState,
} from "@shellular/protocol";
import type Database from "better-sqlite3";
import { getDb, TABLES } from "@/db";
import { logger } from "@/logger";

/**
 * Durable cache of agent chat transcripts, keyed positionally per session.
 *
 * This is a cache, never a source of truth: the agent's own session storage is
 * authoritative, and rows are wholesale-replaced (with a generation bump)
 * whenever a full ACP replay completes. It exists so re-opening a chat renders
 * the newest messages immediately instead of waiting on the 20-30s replay.
 *
 * Message ids are nanoids regenerated on every transcript rebuild, so rows are
 * keyed by transcript index (`idx`), not id. The `generation` counter lets
 * paging clients detect that a full reload replaced history under them.
 *
 * Every public method is fail-soft: any sqlite error logs a warning and
 * returns null/no-ops. A store failure must never break chat.
 *
 * The `agent_*` tables live in the shared project database (`@/db`), created by
 * its migrations; this store owns neither the schema nor the connection.
 */

export interface StoredSessionMeta {
	session: AcpAiSession;
	state: AiSessionState;
	messageCount: number;
	generation: number;
	updatedAt: number;
}

export interface StoredPage {
	messages: AcpMessage[];
	/**
	 * Transcript index of `messages[0]`, inclusive. Undefined iff `messages` is
	 * empty — an empty window has no position, and inventing one produces a
	 * `from` that indexes nothing.
	 */
	from?: number;
	/** One past the last message's index, exclusive. Undefined iff empty. */
	to?: number;
	totalCount: number;
	generation: number;
}

/**
 * A durable read failed (DB unreadable, query threw). Distinct from a `null`
 * return, which means "nothing stored for this session" — a normal, expected
 * answer. This is surfaced to the app so a broken store reads as an error
 * rather than as an empty transcript.
 */
export class TranscriptStoreError extends Error {
	constructor(operation: string, cause: unknown) {
		super(
			`Transcript store: failed to ${operation}: ${
				cause instanceof Error ? cause.message : String(cause)
			}`,
		);
		this.name = "TranscriptStoreError";
		this.cause = cause;
	}
}

interface SessionRow {
	session_json: string;
	state_json: string;
	message_count: number;
	generation: number;
	updated_at: number;
}

interface MessageRow {
	idx: number;
	message_json: string;
}

/** Cheap structural check for rows read back from disk. */
function isValidMessage(value: unknown): value is AcpMessage {
	if (typeof value !== "object" || value === null) return false;
	const message = value as Record<string, unknown>;
	return (
		(message.role === "user" || message.role === "assistant") &&
		Array.isArray(message.parts)
	);
}

export class TranscriptStore {
	private db: Database.Database | null = null;

	constructor() {
		// Migrations have already run by the time any subsystem is constructed
		// (see `migrate()` in main.ts), so the tables either exist or the database
		// is unavailable and every method below degrades to a no-op.
		this.db = getDb();
		if (!this.db) {
			logger.warn(
				"Transcript store unavailable; chat history caching disabled",
			);
		}
	}

	get enabled(): boolean {
		return this.db !== null;
	}

	getSessionMeta(agentId: string, sessionId: string): StoredSessionMeta | null {
		if (!this.db) return null;
		try {
			const row = this.db
				.prepare(
					`SELECT session_json, state_json, message_count, generation, updated_at FROM ${TABLES.sessions} WHERE agent_id = ? AND session_id = ?`,
				)
				.get(agentId, sessionId) as SessionRow | undefined;
			if (!row) return null;
			// A zero-message row is not a usable cache entry: callers take a non-null
			// meta as "the store has this session" and hydrate from it, which renders
			// an empty chat instead of falling through to a live replay. Writes no
			// longer create these, but rows predating that fix still exist on disk —
			// drop them on sight so they self-heal.
			if (row.message_count <= 0) {
				this.deleteSession(agentId, sessionId);
				return null;
			}
			return {
				session: JSON.parse(row.session_json) as AcpAiSession,
				state: JSON.parse(row.state_json) as AiSessionState,
				messageCount: row.message_count,
				generation: row.generation,
				updatedAt: row.updated_at,
			};
		} catch (err) {
			logger.warn("Transcript store: failed to read session meta:", err);
			return null;
		}
	}

	getTail(
		agentId: string,
		sessionId: string,
		limit?: number,
	): StoredPage | null {
		if (!this.db) return null;
		try {
			const meta = this.readSessionRow(agentId, sessionId);
			if (!meta) return null;
			const rows = this.db
				.prepare(
					`SELECT idx, message_json FROM ${TABLES.messages} WHERE agent_id = ? AND session_id = ? ORDER BY idx DESC LIMIT ?`,
				)
				.all(agentId, sessionId, limit ?? -1) as MessageRow[];
			return this.toPage(agentId, sessionId, rows, meta);
		} catch (err) {
			logger.warn("Transcript store: failed to read tail:", err);
			return null;
		}
	}

	/** Read `[to - limit, to)`, newest-first off the index then reversed. */
	getPage(
		agentId: string,
		sessionId: string,
		to: number,
		limit: number,
	): StoredPage | null {
		if (!this.db) return null;
		try {
			const meta = this.readSessionRow(agentId, sessionId);
			if (!meta) return null;
			const rows = this.db
				.prepare(
					`SELECT idx, message_json FROM ${TABLES.messages} WHERE agent_id = ? AND session_id = ? AND idx < ? ORDER BY idx DESC LIMIT ?`,
				)
				.all(agentId, sessionId, to, limit) as MessageRow[];
			return this.toPage(agentId, sessionId, rows, meta);
		} catch (err) {
			logger.warn("Transcript store: failed to read page:", err);
			throw new TranscriptStoreError("read transcript page", err);
		}
	}

	/**
	 * Replace the whole stored transcript in one transaction. Called after a
	 * full authoritative replay; `generation` must be a fresh value so paging
	 * clients can detect the swap.
	 *
	 * An empty transcript is never cached. A replay yielding no messages means we
	 * learned nothing worth persisting — either the session genuinely has no
	 * history, or the replay failed/was cut short. Storing a zero-message row is
	 * worse than storing nothing: a cold attach treats the presence of a session
	 * row as "the cache has this session", hydrates an empty snapshot and returns
	 * early, so the chat renders blank instead of falling through to a live
	 * replay. Any previously-cached transcript is dropped rather than left behind,
	 * since this replay is authoritative about the session being empty.
	 */
	replaceAll(
		agentId: string,
		sessionId: string,
		generation: number,
		meta: { session: AcpAiSession; state: AiSessionState },
		messages: AcpMessage[],
	): void {
		if (!this.db) return;
		if (messages.length === 0) {
			this.deleteSession(agentId, sessionId);
			return;
		}
		try {
			const db = this.db;
			const now = Date.now();
			db.transaction(() => {
				db.prepare(
					`DELETE FROM ${TABLES.messages} WHERE agent_id = ? AND session_id = ?`,
				).run(agentId, sessionId);
				const insert = db.prepare(
					`INSERT INTO ${TABLES.messages} (agent_id, session_id, idx, message_id, message_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
				);
				messages.forEach((message, idx) => {
					insert.run(
						agentId,
						sessionId,
						idx,
						typeof message.id === "string" ? message.id : null,
						JSON.stringify(message),
						now,
					);
				});
				db.prepare(
					`INSERT INTO ${TABLES.sessions} (agent_id, session_id, session_json, state_json, message_count, generation, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT (agent_id, session_id) DO UPDATE SET
					   session_json = excluded.session_json,
					   state_json = excluded.state_json,
					   message_count = excluded.message_count,
					   generation = excluded.generation,
					   updated_at = excluded.updated_at`,
				).run(
					agentId,
					sessionId,
					JSON.stringify(meta.session),
					JSON.stringify(meta.state),
					messages.length,
					generation,
					now,
				);
			})();
		} catch (err) {
			logger.warn("Transcript store: failed to replace transcript:", err);
		}
	}

	/**
	 * Rewrite rows from `fromIdx` to the end out of the full in-memory array.
	 * Used at turn boundaries; leaves `generation` untouched so in-flight scroll
	 * pages stay valid during normal chatting.
	 *
	 * As in `replaceAll`, an empty transcript is never cached — it would create a
	 * session row that makes a cold attach hydrate a blank chat. Unlike
	 * `replaceAll` this is a partial update and not an authoritative view of the
	 * whole session, so it leaves any existing rows alone rather than deleting
	 * them.
	 */
	writeFrom(
		agentId: string,
		sessionId: string,
		fromIdx: number,
		fullMessages: AcpMessage[],
		meta?: {
			session?: AcpAiSession;
			state?: AiSessionState;
			generation?: number;
		},
	): void {
		if (!this.db) return;
		if (fullMessages.length === 0) return;
		try {
			const db = this.db;
			const now = Date.now();
			db.transaction(() => {
				// Clamp so a caller anchored on a snapshot that raced a store
				// replace can never leave an index gap: never start past the end of
				// what's stored, and start from zero when nothing is stored yet.
				const existing = db
					.prepare(
						`SELECT message_count FROM ${TABLES.sessions} WHERE agent_id = ? AND session_id = ?`,
					)
					.get(agentId, sessionId) as
					| Pick<SessionRow, "message_count">
					| undefined;
				fromIdx = Math.min(fromIdx, existing?.message_count ?? 0);
				db.prepare(
					`DELETE FROM ${TABLES.messages} WHERE agent_id = ? AND session_id = ? AND idx >= ?`,
				).run(agentId, sessionId, fromIdx);
				const insert = db.prepare(
					`INSERT INTO ${TABLES.messages} (agent_id, session_id, idx, message_id, message_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
				);
				for (let idx = fromIdx; idx < fullMessages.length; idx += 1) {
					const message = fullMessages[idx];
					insert.run(
						agentId,
						sessionId,
						idx,
						typeof message.id === "string" ? message.id : null,
						JSON.stringify(message),
						now,
					);
				}
				if (meta?.session) {
					db.prepare(
						`INSERT INTO ${TABLES.sessions} (agent_id, session_id, session_json, state_json, message_count, generation, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?)
						 ON CONFLICT (agent_id, session_id) DO UPDATE SET
						   session_json = excluded.session_json,
						   state_json = excluded.state_json,
						   message_count = excluded.message_count,
						   updated_at = excluded.updated_at`,
					).run(
						agentId,
						sessionId,
						JSON.stringify(meta.session),
						JSON.stringify(meta.state ?? {}),
						fullMessages.length,
						meta.generation ?? 0,
						now,
					);
				} else {
					db.prepare(
						`UPDATE ${TABLES.sessions} SET message_count = ?, updated_at = ? WHERE agent_id = ? AND session_id = ?`,
					).run(fullMessages.length, now, agentId, sessionId);
				}
			})();
		} catch (err) {
			logger.warn("Transcript store: failed to write turn:", err);
		}
	}

	deleteSession(agentId: string, sessionId: string): void {
		if (!this.db) return;
		try {
			const db = this.db;
			db.transaction(() => {
				db.prepare(
					`DELETE FROM ${TABLES.messages} WHERE agent_id = ? AND session_id = ?`,
				).run(agentId, sessionId);
				db.prepare(
					`DELETE FROM ${TABLES.sessions} WHERE agent_id = ? AND session_id = ?`,
				).run(agentId, sessionId);
			})();
		} catch (err) {
			logger.warn("Transcript store: failed to delete session:", err);
		}
	}

	/**
	 * Detach from the shared connection. The connection itself belongs to the
	 * process (`closeDb()`), not to this store, so it is deliberately not closed
	 * here — other domains may still be using it.
	 */
	close(): void {
		this.db = null;
	}

	private readSessionRow(
		agentId: string,
		sessionId: string,
	): SessionRow | null {
		if (!this.db) return null;
		const row = this.db
			.prepare(
				`SELECT session_json, state_json, message_count, generation, updated_at FROM ${TABLES.sessions} WHERE agent_id = ? AND session_id = ?`,
			)
			.get(agentId, sessionId) as SessionRow | undefined;
		if (!row) return null;
		// Mirrors getSessionMeta: an empty row is not a cache hit (see there).
		if (row.message_count <= 0) {
			this.deleteSession(agentId, sessionId);
			return null;
		}
		return row;
	}

	/**
	 * Rows arrive newest-first from the DESC queries; parse, validate, and flip
	 * to chronological order. Any bad row poisons the whole session (dropped and
	 * null returned) so a partially-corrupt transcript can never render holes.
	 */
	private toPage(
		agentId: string,
		sessionId: string,
		rows: MessageRow[],
		meta: SessionRow,
	): StoredPage | null {
		const messages: AcpMessage[] = [];
		for (const row of rows) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(row.message_json);
			} catch {
				parsed = null;
			}
			if (!isValidMessage(parsed)) {
				logger.warn(
					`Transcript store: dropping corrupt transcript for ${agentId}:${sessionId}`,
				);
				this.deleteSession(agentId, sessionId);
				return null;
			}
			messages.push(parsed);
		}
		messages.reverse();
		// `rows` is newest-first (idx DESC), so the last row is the oldest and
		// the first row is the newest; `to` is exclusive, hence +1. No rows means
		// no window, so both bounds stay undefined rather than collapsing to 0.
		return {
			messages,
			from: rows.length > 0 ? rows[rows.length - 1].idx : undefined,
			to: rows.length > 0 ? rows[0].idx + 1 : undefined,
			totalCount: meta.message_count,
			generation: meta.generation,
		};
	}
}

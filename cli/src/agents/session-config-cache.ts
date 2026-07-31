import {
	AcpAvailableCommandSchema,
	AiSessionConfigOptionSchema,
} from "@shellular/protocol";
import type Database from "better-sqlite3";
import { z } from "zod";
import { getDb } from "@/db";
import { logger } from "@/logger";

/**
 * Durable cache of the session config each agent last advertised: config options
 * (modes, models, thought levels) and slash commands.
 *
 * ACP only exposes these once a session exists, but a chat's session is created
 * lazily — not until the user sends their first message — so a draft chat has
 * nothing to ask. These rows let the composer render a real toolbar in the
 * meantime.
 *
 * This is a cache, never a source of truth: the live session's values replace it
 * as soon as one is created. Every function is fail-soft — a sqlite error logs a
 * warning and degrades to "no cache", because a missing toolbar hint must never
 * break chat.
 *
 * The `agent_session_config_cache` table lives in the shared project database
 * (`@/db`) and is created by its migrations; this module owns neither the schema
 * nor the connection.
 */

const cachedAgentConfigSchema = z.object({
	configOptions: z.array(AiSessionConfigOptionSchema).default([]),
	availableCommands: z.array(AcpAvailableCommandSchema).default([]),
	modes: z.unknown().optional(),
	/** Agent version this was captured from; a change invalidates the entry. */
	version: z.string().optional(),
	updatedAt: z.number().default(0),
});

export type CachedAgentSessionConfig = z.infer<typeof cachedAgentConfigSchema>;

interface ConfigRow {
	config_json: string;
	commands_json: string;
	modes_json: string | null;
	agent_version: string | null;
	updated_at: number;
}

/**
 * Migrations have already run by the time any subsystem asks for this (see
 * `migrate()` in main.ts), so the table either exists or the database is
 * unavailable and every function below degrades to a no-op.
 */
function handle(): Database.Database | null {
	return getDb();
}

export function readCachedSessionConfig(
	agentId: string,
	version?: string,
): CachedAgentSessionConfig | null {
	const db = handle();
	if (!db) return null;
	try {
		const row = db
			.prepare(
				"SELECT config_json, commands_json, modes_json, agent_version, updated_at FROM agent_session_config_cache WHERE agent_id = ?",
			)
			.get(agentId) as ConfigRow | undefined;
		if (!row) return null;
		// Slash commands and model lists move between agent releases; a stale list
		// is worse than none because the user can pick something that no longer
		// exists.
		if (version && row.agent_version && row.agent_version !== version) {
			return null;
		}
		const parsed = cachedAgentConfigSchema.safeParse({
			configOptions: JSON.parse(row.config_json),
			availableCommands: JSON.parse(row.commands_json),
			modes: row.modes_json ? JSON.parse(row.modes_json) : undefined,
			version: row.agent_version ?? undefined,
			updatedAt: row.updated_at,
		});
		// A row that no longer matches the schema is derived data the next live
		// session rebuilds — drop it rather than serving a shape the app can't use.
		return parsed.success ? parsed.data : null;
	} catch (err) {
		logger.warn(
			`Session config cache: failed to read config for ${agentId}:`,
			err,
		);
		return null;
	}
}

/**
 * Record what an agent advertised for a live session. Empty updates are dropped
 * rather than persisted: agents send `available_commands_update` asynchronously,
 * so a session's first state often has commands still unset, and writing that
 * would erase a good row.
 */
export function writeCachedSessionConfig(
	agentId: string,
	next: {
		configOptions?: unknown;
		availableCommands?: unknown;
		modes?: unknown;
		version?: string;
	},
) {
	const configOptions = Array.isArray(next.configOptions)
		? next.configOptions
		: undefined;
	const availableCommands = Array.isArray(next.availableCommands)
		? next.availableCommands
		: undefined;
	if (!configOptions?.length && !availableCommands?.length) return;

	const db = handle();
	if (!db) return;
	try {
		// Merge field-by-field against whatever is stored: a session that only
		// carried config options must not blank out previously-cached commands.
		const existing = readCachedSessionConfig(agentId);
		const merged = cachedAgentConfigSchema.parse({
			configOptions: configOptions?.length
				? configOptions
				: (existing?.configOptions ?? []),
			availableCommands: availableCommands?.length
				? availableCommands
				: (existing?.availableCommands ?? []),
			modes: next.modes ?? existing?.modes,
			version: next.version ?? existing?.version,
			updatedAt: Date.now(),
		});
		db.prepare(
			`INSERT INTO agent_session_config_cache
				(agent_id, config_json, commands_json, modes_json, agent_version, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(agent_id) DO UPDATE SET
				config_json   = excluded.config_json,
				commands_json = excluded.commands_json,
				modes_json    = excluded.modes_json,
				agent_version = excluded.agent_version,
				updated_at    = excluded.updated_at`,
		).run(
			agentId,
			JSON.stringify(merged.configOptions),
			JSON.stringify(merged.availableCommands),
			merged.modes === undefined ? null : JSON.stringify(merged.modes),
			merged.version ?? null,
			merged.updatedAt,
		);
	} catch (err) {
		// Purely an optimisation: a failed write must never break a live session.
		logger.warn(
			`Session config cache: failed to cache config for ${agentId}:`,
			err,
		);
	}
}

import Database from "better-sqlite3";
import { config } from "@/config";
import { logger } from "@/logger";
import migration001 from "./sql/001_init.sql";

/**
 * Project-wide SQLite database.
 *
 * One file (`~/.shellular/shellular.sqlite`) shared by every feature that needs
 * durable structured state, replacing the individual JSON files scattered
 * across the project.
 *
 * Opening is lazy and fail-soft: if SQLite is unavailable (read-only home,
 * corrupt file, missing native binding) `getDb()` returns null and callers
 * degrade instead of crashing. Persistence is an optimisation, never a
 * prerequisite for the CLI running.
 */

/**
 * Every migration, in order. Index + 1 is the version number it produces, so
 * `MIGRATIONS[0]` takes a fresh database to `user_version = 1`.
 *
 * Append only. A shipped migration is never edited or reordered — installs that
 * already ran it would never see the change, so their schema would silently
 * diverge from a fresh install's. Fix forward with a new file instead.
 *
 * Imported explicitly rather than by glob so the bundler can inline each file
 * (see `loader: { ".sql": "text" }` in tsup.config.ts) and so the order is
 * stated here rather than depending on directory iteration.
 */
const MIGRATIONS: string[] = [migration001];

let db: Database.Database | null = null;
let opened = false;

/**
 * The shared connection, or null when SQLite is unavailable. Opened on first
 * call; a failed open is remembered so every later call is a cheap null.
 *
 * Callers get an unmigrated handle — `migrate()` is what makes the schema
 * usable, and it is run once during startup rather than here.
 */
export function getDb(): Database.Database | null {
	if (opened) return db;
	opened = true;
	try {
		// `ensureConfig()` creates SHELLULAR_DIR at startup, so the parent
		// directory already exists by the time anything asks for the database.
		const handle = new Database(config.SHELLULAR_DB_FILE);
		// WAL lets readers run alongside a writer, which matters as soon as
		// anything other than the daemon touches this file. Unlike the pragmas
		// below this one persists in the file, but it must be set outside a
		// transaction, so it belongs here at open time either way.
		handle.pragma("journal_mode = WAL");
		// Durable enough without fsync-per-commit; the loss window on power cut
		// is the last transaction, which is acceptable for cached state.
		handle.pragma("synchronous = NORMAL");
		// Wait instead of throwing SQLITE_BUSY when another process holds the
		// write lock (a second CLI, a migration, an inspection tool).
		handle.pragma("busy_timeout = 5000");
		// Per-connection and not persisted: every new connection must set it.
		handle.pragma("foreign_keys = ON");
		db = handle;
		logger.debug(`SQLite ready at ${config.SHELLULAR_DB_FILE}`);
	} catch (err) {
		logger.warn(
			`SQLite unavailable at ${config.SHELLULAR_DB_FILE}; durable caches disabled:`,
			err,
		);
		db = null;
	}
	return db;
}

/**
 * Raised when the database was migrated by a newer build than this one.
 * Fatal, unlike every other database failure here — see `migrate()`.
 */
export class SchemaTooNewError extends Error {
	constructor(found: number, known: number) {
		super(
			`Database schema is v${found} but this version of ${config.NAME} (v${config.VERSION}) only knows v${known}. ` +
				`Update to the latest version to continue: npm i -g ${config.NAME}@latest ` +
				`(if you launched via npx, clear its cache with \`npx clear-npx-cache\`).`,
		);
		this.name = "SchemaTooNewError";
	}
}

/**
 * Bring the database up to the latest schema version.
 *
 * Version lives in `PRAGMA user_version`; every migration numbered above it is
 * applied in order. Each runs in its own transaction *with* its version bump,
 * so the two can never disagree — SQLite DDL is transactional, so a crash
 * mid-run leaves the previous version fully intact and the next start resumes
 * from there.
 *
 * Call once, after arg parsing: `--help` and `--version` should never touch the
 * database.
 *
 * Returns false when the database is simply unavailable or a migration failed,
 * so callers degrade to their in-memory paths. The one case that is *not*
 * survivable throws `SchemaTooNewError`: a database migrated by a newer build
 * (typically a stale npx cache) whose extra migrations this binary cannot
 * understand, so writing to it risks producing rows the newer schema rejects.
 */
export function migrate(): boolean {
	const handle = getDb();
	if (!handle) return false;
	const current = Number(handle.pragma("user_version", { simple: true }));
	if (current > MIGRATIONS.length) {
		throw new SchemaTooNewError(current, MIGRATIONS.length);
	}
	try {
		if (current === MIGRATIONS.length) return true;

		for (
			let version = current + 1;
			version <= MIGRATIONS.length;
			version += 1
		) {
			const sql = MIGRATIONS[version - 1];
			handle.transaction(() => {
				handle.exec(sql);
				// `PRAGMA user_version` takes no bound parameter, so the value is
				// interpolated — it is a loop counter, never user input.
				handle.pragma(`user_version = ${version}`);
			})();
			logger.debug(`SQLite migrated to v${version}`);
		}
		return true;
	} catch (err) {
		logger.warn("SQLite migration failed; durable caches disabled:", err);
		return false;
	}
}

/** Close the shared connection. Called on daemon shutdown. */
export function closeDb(): void {
	try {
		db?.close();
	} catch {
		// Ignore: the process is going down anyway.
	}
	db = null;
	opened = false;
}

/**
 * Regenerate `schema.sql` — the human-readable current state of the database.
 *
 * Replays every migration into an in-memory database and dumps `sqlite_schema`,
 * so the committed file is derived, never hand-edited. Two things it buys:
 * a reviewable diff of what a schema change actually did, and a CI check that
 * catches edits to already-shipped migrations (`git diff --exit-code
 * schema.sql` after regenerating — a changed past migration moves the dump
 * while a correctly appended one only adds to it).
 *
 * Run via `pnpm run schema` (and automatically on `prepublishOnly`).
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const here = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(here, "..", "src", "db", "sql");
const OUT_FILE = path.join(here, "..", "schema.sql");

const files = readdirSync(SQL_DIR)
	.filter((name) => name.endsWith(".sql"))
	.sort();

const db = new Database(":memory:");
for (const [index, name] of files.entries()) {
	const version = index + 1;
	const expected = String(version).padStart(3, "0");
	if (!name.startsWith(`${expected}_`)) {
		throw new Error(
			`Migration files must be zero-padded and sequential from 001: expected ${expected}_*.sql, found ${name}`,
		);
	}
	const sql = readFileSync(path.join(SQL_DIR, name), "utf-8");
	db.transaction(() => {
		db.exec(sql);
		db.pragma(`user_version = ${version}`);
	})();
}

const objects = db
	.prepare(
		"SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name",
	)
	.all() as { sql: string }[];

const userVersion = db.pragma("user_version", { simple: true });

const body = [
	"-- GENERATED FILE — do not edit.",
	"-- Current database schema, produced by replaying src/db/sql/*.sql.",
	"-- Regenerate with `pnpm run schema`.",
	"",
	`PRAGMA user_version = ${userVersion};`,
	"",
	...objects.map((row) => `${row.sql.trim()};`),
	"",
].join("\n");

writeFileSync(OUT_FILE, body, "utf-8");
db.close();

console.log(
	`schema.sql regenerated from ${files.length} migration(s) at v${userVersion}`,
);

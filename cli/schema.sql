-- GENERATED FILE — do not edit.
-- Current database schema, produced by replaying src/db/sql/*.sql.
-- Regenerate with `pnpm run schema`.

PRAGMA user_version = 1;

CREATE TABLE ai_messages (
	agent_id     TEXT    NOT NULL,
	session_id   TEXT    NOT NULL,
	idx          INTEGER NOT NULL,
	message_id   TEXT,
	message_json TEXT    NOT NULL,
	updated_at   INTEGER NOT NULL,
	PRIMARY KEY (agent_id, session_id, idx)
);
CREATE TABLE ai_sessions (
	agent_id      TEXT    NOT NULL,
	session_id    TEXT    NOT NULL,
	session_json  TEXT    NOT NULL,
	state_json    TEXT    NOT NULL,
	message_count INTEGER NOT NULL,
	generation    INTEGER NOT NULL DEFAULT 0,
	updated_at    INTEGER NOT NULL,
	PRIMARY KEY (agent_id, session_id)
);

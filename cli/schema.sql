-- GENERATED FILE — do not edit.
-- Current database schema, produced by replaying src/db/sql/*.sql.
-- Regenerate with `pnpm run schema`.

PRAGMA user_version = 3;

CREATE TABLE agent_messages (
	agent_id     TEXT    NOT NULL,
	session_id   TEXT    NOT NULL,
	idx          INTEGER NOT NULL,
	message_id   TEXT,
	message_json TEXT    NOT NULL,
	updated_at   INTEGER NOT NULL,
	PRIMARY KEY (agent_id, session_id, idx)
);
CREATE TABLE agent_session_config_cache (
	agent_id           TEXT    NOT NULL PRIMARY KEY,
	config_json        TEXT    NOT NULL,
	commands_json      TEXT    NOT NULL,
	modes_json         TEXT,
	-- Agent version this was captured from. Slash commands and model lists move
	-- between releases, so a row from a different version is discarded rather
	-- than offering the user a model that no longer exists.
	agent_version      TEXT,
	updated_at         INTEGER NOT NULL
);
CREATE TABLE agent_sessions (
	agent_id      TEXT    NOT NULL,
	session_id    TEXT    NOT NULL,
	session_json  TEXT    NOT NULL,
	state_json    TEXT    NOT NULL,
	message_count INTEGER NOT NULL,
	generation    INTEGER NOT NULL DEFAULT 0,
	updated_at    INTEGER NOT NULL,
	PRIMARY KEY (agent_id, session_id)
);

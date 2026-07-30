-- Durable cache of agent chat transcripts, keyed positionally per session so a
-- reopened chat renders instantly instead of waiting on ACP's full replay.
--
-- Never a source of truth: the agent's own session storage is authoritative and
-- these rows are wholesale-replaced whenever a full replay completes. A future
-- migration that needs to change their shape is free to drop and recreate them
-- rather than preserving rows.

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

CREATE TABLE ai_messages (
	agent_id     TEXT    NOT NULL,
	session_id   TEXT    NOT NULL,
	idx          INTEGER NOT NULL,
	message_id   TEXT,
	message_json TEXT    NOT NULL,
	updated_at   INTEGER NOT NULL,
	PRIMARY KEY (agent_id, session_id, idx)
);

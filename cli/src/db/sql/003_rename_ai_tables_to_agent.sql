-- Rename the transcript cache tables from `ai_*` to `agent_*`, matching the
-- `agent_session_config_cache` naming introduced in 002.
--
-- Dropped and recreated rather than renamed. These tables are a pure cache with
-- an authoritative upstream (the agent's own session storage), so discarding
-- rows costs one replay per reopened chat and nothing else — exactly what
-- 001_init.sql anticipated when it noted a future migration is free to drop and
-- recreate them. Starting empty also clears rows written before empty
-- transcripts were rejected, which are unusable anyway: a zero-message row
-- reads as a cache hit and renders a blank chat.

DROP TABLE IF EXISTS ai_messages;
DROP TABLE IF EXISTS ai_sessions;

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

CREATE TABLE agent_messages (
	agent_id     TEXT    NOT NULL,
	session_id   TEXT    NOT NULL,
	idx          INTEGER NOT NULL,
	message_id   TEXT,
	message_json TEXT    NOT NULL,
	updated_at   INTEGER NOT NULL,
	PRIMARY KEY (agent_id, session_id, idx)
);

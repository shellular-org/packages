-- Last-known session config per agent: config options (modes, models, thought
-- levels) and slash commands.
--
-- ACP only reveals these once a session exists, but the app creates a chat's
-- session lazily — not until the first message is sent — so a draft chat has
-- nothing to ask. These rows let the composer render a real toolbar before that
-- first send, using whatever the agent last advertised.
--
-- Never a source of truth: the live session's values replace these as soon as
-- one is created, and a row is only advisory in between. One row per agent, so
-- writes are upserts on the primary key.

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

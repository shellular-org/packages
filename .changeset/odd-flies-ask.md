---
"shellular": patch
---

Cache each agent's session config (models, modes, slash commands) in SQLite so the app can render a populated composer for a chat that has no session yet.

ACP only exposes config once a session exists, but the app now creates one lazily on first send. The last-known config per agent is persisted and returned with the agent list, then refreshed whenever an agent advertises new values — on `session/load`, on `config_option_update`/`available_commands_update` notifications, and on `session/set_config_option` responses.

Adds an internal `m-id` command that prints the machine ID.

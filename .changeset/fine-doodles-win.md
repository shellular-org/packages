---
"shellular": patch
---

Fix false-success daemon start/restart, prefix streamed logs, and harden shutdown

- `start`/`restart` no longer report success the instant PM2 forks the daemon. `pollDaemonReady` now requires the process to hold `online` for a stability window and watches the restart counter to catch crash loops, so a daemon that dies on startup is reported as failed instead of "running".
- On start failure, detect the stale-PM2-module case (leftover daemon resolving modules from a removed install) and print a targeted `npx pm2 kill` recovery hint instead of a raw `MODULE_NOT_FOUND`.
- Streamed logs are prefixed with `[stdout]`/`[stderr]` via a line-buffering transform so the two streams are distinguishable.
- Add `spawnEnvOverride` hook so agent subclasses can inject host-state-dependent env at spawn time, and surface agent prompt failures with a logged error instead of a swallowed `void` promise.
- Prevent completed streamed assistant messages from disappearing by waiting for ACP session updates to settle, preferring the resident live snapshot when finalizing prompt results, and avoiding stale external refreshes while a live session is attached.
- Persist and lazily restore per-session ACP config choices so resumed sessions keep user-selected model/mode/permission settings across navigation and CLI restarts.
- Cache agent session config for draft chats, keep new chats as true drafts until the first prompt, and apply the exact draft config shown in the app when that first prompt creates the ACP session.

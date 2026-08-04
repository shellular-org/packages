---
"shellular": patch
---

Fix false-success daemon start/restart, prefix streamed logs, and harden shutdown

- `start`/`restart` no longer report success the instant PM2 forks the daemon. `pollDaemonReady` now requires the process to hold `online` for a stability window and watches the restart counter to catch crash loops, so a daemon that dies on startup is reported as failed instead of "running".
- On start failure, detect the stale-PM2-module case (leftover daemon resolving modules from a removed install) and print a targeted `npx pm2 kill` recovery hint instead of a raw `MODULE_NOT_FOUND`.
- Streamed logs are prefixed with `[stdout]`/`[stderr]` via a line-buffering transform so the two streams are distinguishable.
- Make process cleanup idempotent and actually exit on SIGINT/SIGTERM (previously handlers ran cleanup but never exited, so the process could hang on Ctrl+C / `pm2 stop`).
- Add `spawnEnvOverride` hook so agent subclasses can inject host-state-dependent env at spawn time, and surface agent prompt failures with a logged error instead of a swallowed `void` promise.

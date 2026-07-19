---
"shellular": patch
"@shellular/protocol": patch
---

various fixes and improvements

- fix(battery): prevent leaks by stopping battery stream on any disconnect
- fix(terminal): restore per-client on connect, keep snapshots clean

  Restore ran at boot for every terminal, firing PTY events at absent clients
  and stacking a "History restored" divider per restart. Now driven by
  SESSION_CLIENT_JOINED and idempotent across reconnects.

  Restored scrollback moved out of the headless buffer into
  entry.restoredHistory, joined at serialize time so the divider never
  persists. `clear` drops it via an ED2/ED3 handler.

- fix: make ai agents detection async (it was sync before)
- chore: removed old & unused AI_AVAILABILITY related messages from protocol & CLI
- fix: add notification for new relay servers in US and EU for lower latency

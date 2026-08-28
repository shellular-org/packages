---
"shellular": patch
---

- fix(agents): set `CLAUDE_CODE_ENTRYPOINT` when spawning the Claude Code adapter, so sessions started from the app appear in `/resume` and in the VS Code session list instead of being filtered out as SDK sessions. An operator who exports their own value keeps it.

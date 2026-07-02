---
"shellular": patch
---

Fix external agent session tracking. Sessions run directly in the terminal (Claude Code / Codex) now load their messages reliably when opened, stay visible while their CLI is open even after a turn finishes, and no longer show empty (opened-then-cancelled) or duplicate entries.

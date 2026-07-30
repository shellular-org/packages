---
"@shellular/protocol": patch
"shellular": patch
---

feat: faster chat reopens, paged transcripts, and ACP elicitation support.

**Transcript cache (SQLite).** Agent chat transcripts are now cached in a shared
`~/.shellular/shellular.sqlite`, so reopening a chat renders immediately instead
of waiting on ACP's 20–30s full replay. The cache is never a source of truth —
the agent's own session storage stays authoritative and rows are replaced
wholesale (with a generation bump) after each full replay. SQLite is fail-soft:
if it can't be opened, everything degrades to the previous in-memory behavior.
Migrations live in `src/db/sql/*.sql` and are append-only, with a generated
`schema.sql` and a CI check that catches edits to already-shipped migrations.

**Paged transcripts.** `ai:session:attach` accepts `tail` or `from`/`to` to
request a slice of the transcript, and `ai:messages:list` accepts `to`/`limit`
for scroll-back. Both responses report the window actually served (`from`, `to`,
`totalCount`, `hasMoreBefore`, `generation`) so clients can page backwards
without overlap. `ai:session:load` is removed — `ai:session:attach` covers it.

**Compressed payloads.** Encrypted envelopes may now carry `enc: "gzip"`,
compressing before encryption so the relay still sees only routing fields and
opaque ciphertext. Only sent to apps new enough to decode it (inferred from
`appVersion`), and only above 4 KB; older apps keep receiving raw UTF-8.

**ACP elicitation.** Agents can request structured input mid-turn
(`ai:elicitation:reply`), covering agent question forms, MCP server
elicitations, and sign-in URLs. Tool calls also carry `locations`, and plans
carry `entries`.

**Fixes.**

- Wait for the ACP dispatcher to settle before reading a loaded transcript — the
  tail of a replay could previously be dropped.
- Honor agent-provided `messageId` as a message boundary, so consecutive
  same-role messages no longer merge and message ids stay stable across reloads.
- Wait 1.5s before redialing a relay that just failed; failover to a different
  relay is still immediate.
- Log timestamps use ISO format (millisecond resolution) instead of
  second-resolution `toUTCString()`.

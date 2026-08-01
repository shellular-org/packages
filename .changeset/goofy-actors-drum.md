---
"shellular": patch
---

Fix phantom sessions on the home view. Sessions whose CLI is long gone no longer
show as active — liveness is matched against a live process's start time, not its
directory alone, so one open CLI no longer vouches for every past session in that
folder. Claude sub-agent transcripts (`subagents/agent-*.jsonl`) are no longer
listed at all: their ids aren't resumable, so those entries could never be opened.

Sessions with no messages are no longer cached. A zero-message row read as a cache
hit and rendered a blank chat instead of falling back to a live replay.

Renames the transcript cache tables from `ai_*` to `agent_*`. They're a pure cache,
so the migration recreates them empty; the first reopen of each chat replays once,
then renders instantly again.

---
"shellular": patch
---

Fix git status indicators not appearing in the file browser.

`stdout.trim()` was stripping the leading space from the first line of `git status --porcelain=v1` output. Since porcelain v1 uses that leading space as a significant status column (e.g. ` M` = modified in worktree), trimming it shifted the line left by one character, causing `slice(3)` to drop the first character of the file path. This produced wrong map keys (e.g. `rc/components/Hero.astro` instead of `src/components/Hero.astro`), so directory status rollup failed and no `M`/`A`/etc. badges were shown.

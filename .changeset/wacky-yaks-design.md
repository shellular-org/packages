---
"shellular": patch
---

fix: no TTL for terminals. previously, if a terminal had been active for 7 days, it used to get killed & cleaned up, even if the user didn't want it to happen.

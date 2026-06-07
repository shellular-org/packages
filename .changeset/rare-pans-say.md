---
"shellular": patch
---

fix: prevent daemon startup failures from repeatedly registering hosts.

the daemon now runs host registration as a startup preflight before launching the PM2-managed process, and PM2 restarts are capped to avoid infinite restart loops on rapid failures.

---
"@shellular/protocol": patch
"shellular": patch
---

fix: session attach/detach with multi-client support, lazy session snapshots, and runtime cleanup

- Add AI_SESSION_ATTACH and AI_SESSION_DETACH for explicit session lifecycle management
- Implement session snapshots with revision tracking for efficient state sync
- Add runtime cleanup timers to prevent memory leaks from idle sessions
- Fix race condition preventing reuse of destroyed ACP runtimes
- Fix root path resolution to not inadvertently form double-slash paths

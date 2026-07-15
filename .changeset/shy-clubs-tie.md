---
"@shellular/protocol": patch
---

fix(protocol): auth is now mandatory for new versions

- removed user field from ClientInfoSchema
- and hence also removed ClientInfoRequestSchema
- added ServerCloseCodeAndReason object to use between client, server and CLI
- this breaks things in CLI, so the CLI build should fail. CLI will be updated in the next multi-region PR to use this protocol change.

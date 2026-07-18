---
"@shellular/protocol": patch
"shellular": patch
---

feat(multi-region): refactor connection handling to support relay resolution and token management

- Updated client info types to use AuthedClientInfo.
- Introduced DEFAULT_SERVER_URL in config for easier server URL management.
- Enhanced connection logic to handle relay URLs and token validation.
- Added new error classes for better error handling during connection upgrades.
- Implemented relay probing and caching mechanism to optimize connection speed.
- Updated main CLI logic to utilize the new server URL configuration.
- Introduced relay module for managing relay connections and token fetching.
- Added server URL validation to ensure only HTTP/HTTPS protocols are accepted.
- Updated user gate checks to use the new AuthedClientInfo type.
- Bumped @biomejs/biome dependency.

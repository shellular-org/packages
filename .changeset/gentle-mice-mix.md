---
"shellular": patch
---

fix: strip leaked nvm environment variables when spawning terminals

Spawned terminals inherited the daemon's environment, which carried whatever shell state was active when `shellular start` ran. When the daemon was launched under nvm, the leaked `npm_config_prefix` made nvm print a "not compatible with npm_config_prefix" warning before every prompt. New terminals now start with the nvm-family variables (`npm_config_prefix`, `NVM_DIR`, `NVM_BIN`, `NVM_INC`, `NVM_CD_FLAGS`) removed, so the login shell rebuilds them cleanly from the user's rc files. `nvm` still works in the terminal.
'

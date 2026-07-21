# shellular

## 0.0.48

### Patch Changes

- 9d968fa: various fixes and improvements

  - fix(battery): prevent leaks by stopping battery stream on any disconnect
  - fix(terminal): restore per-client on connect, keep snapshots clean

    Restore ran at boot for every terminal, firing PTY events at absent clients
    and stacking a "History restored" divider per restart. Now driven by
    SESSION_CLIENT_JOINED and idempotent across reconnects.

    Restored scrollback moved out of the headless buffer into
    entry.restoredHistory, joined at serialize time so the divider never
    persists. `clear` drops it via an ED2/ED3 handler.

  - fix: make ai agents detection async (it was sync before)
  - chore: removed old & unused AI_AVAILABILITY related messages from protocol & CLI
  - fix: add notification for new relay servers in US and EU for lower latency

- Updated dependencies [9d968fa]
  - @shellular/protocol@0.0.29

## 0.0.47

### Patch Changes

- 4d73ef7: feat(multi-region): refactor connection handling to support relay resolution and token management

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

- 712bb39: chore: upgrade to latest version of ACP SDK
- Updated dependencies [4d73ef7]
- Updated dependencies [712bb39]
  - @shellular/protocol@0.0.28

## 0.0.46

### Patch Changes

- d99904e: fix: A positive allowlist match trumps the per-device approval flow

## 0.0.45

### Patch Changes

- a46e941: feat(users): implement account allowlist management and user identity handling
- Updated dependencies [a46e941]
  - @shellular/protocol@0.0.26

## 0.0.44

### Patch Changes

- 0c27774: feat: add support for Grok Build
- 9c8a975: feat(terminal): implement terminal session restoration across CLI restarts
- Updated dependencies [0c27774]
  - @shellular/protocol@0.0.25

## 0.0.43

### Patch Changes

- 8e319ac: refactor: rename AiBackend to AgentId, and add codex shell install method
- Updated dependencies [8e319ac]
  - @shellular/protocol@0.0.24

## 0.0.42

### Patch Changes

- fcd0008: fix(update): resolve and pin Shellular version during update process

## 0.0.41

### Patch Changes

- d8770d1: feat(git): push, pull, stage, unstage, commit, pull, push
- Updated dependencies [d8770d1]
  - @shellular/protocol@0.0.23

## 0.0.40

### Patch Changes

- e7c3169: Fix external agent session tracking. Sessions run directly in the terminal (Claude Code / Codex) now load their messages reliably when opened, stay visible while their CLI is open even after a turn finishes, and no longer show empty (opened-then-cancelled) or duplicate entries.

## 0.0.39

### Patch Changes

- 6067397: feat: show shellular version in app, and update

  - Add `showSelfUpdateLogs` function to display self-update logs with live streaming of the latest log file.
  - Introduce `runSelfUpdate` function to handle self-update execution, ensuring proper detachment from the parent process.
  - Update `pm2` and remove unused dependencies
  - Add startup and unstartup sub-commands to manage Shellular CLI daemon startup (wrapper over PM2)
  - Add `--no-qr` option to the CLI to not show QR code
  - Extend protocol with new message types for host updates and results, including schemas for validation.
  - Modify session information to include CLI version and update availability status.

- Updated dependencies [6067397]
  - @shellular/protocol@0.0.22

## 0.0.38

### Patch Changes

- 025d3a9: feat: monitor active claude code and codex sessions and send it to FE so that they can be shown under active sessions for seamless handoff
- Updated dependencies [025d3a9]
  - @shellular/protocol@0.0.21

## 0.0.37

### Patch Changes

- 7a6d943: Update ACP SDK usage to the latest session configuration API and remove the obsolete session model selector bridge.
- f45de64: fix: strip leaked nvm environment variables when spawning terminals

  Spawned terminals inherited the daemon's environment, which carried whatever shell state was active when `shellular start` ran. When the daemon was launched under nvm, the leaked `npm_config_prefix` made nvm print a "not compatible with npm_config_prefix" warning before every prompt. New terminals now start with the nvm-family variables (`npm_config_prefix`, `NVM_DIR`, `NVM_BIN`, `NVM_INC`, `NVM_CD_FLAGS`) removed, so the login shell rebuilds them cleanly from the user's rc files. `nvm` still works in the terminal.

- 87ef273: feat: implement portless URL mapping in ports handler (https://portless.sh/)
- Updated dependencies [7a6d943]
- Updated dependencies [87ef273]
  - @shellular/protocol@0.0.20

## 0.0.36

### Patch Changes

- c18c131: fix: make sure npx spawn for ACP work on windows, and pin ACP sdk version to 0.23.0 since the unstable model setting was removed
- Updated dependencies [c18c131]
  - @shellular/protocol@0.0.19

## 0.0.35

### Patch Changes

- 36258a6: fix: no TTL for terminals. previously, if a terminal had been active for 7 days, it used to get killed & cleaned up, even if the user didn't want it to happen.

## 0.0.34

### Patch Changes

- 1415220: feat: allow users to add custom ACP agents
- Updated dependencies [1415220]
  - @shellular/protocol@0.0.18

## 0.0.33

### Patch Changes

- d71b927: feat: implement git commit file diff functionality with message schemas
- Updated dependencies [d71b927]
  - @shellular/protocol@0.0.17

## 0.0.32

### Patch Changes

- a55f9a3: feat: add git log and commit files functionality with message schemas
- Updated dependencies [a55f9a3]
  - @shellular/protocol@0.0.16

## 0.0.31

### Patch Changes

- 150f2c8: feat: a flag to show hidden files
- da86f21: Fix git status indicators not appearing in the file browser.

  `stdout.trim()` was stripping the leading space from the first line of `git status --porcelain=v1` output. Since porcelain v1 uses that leading space as a significant status column (e.g. ` M` = modified in worktree), trimming it shifted the line left by one character, causing `slice(3)` to drop the first character of the file path. This produced wrong map keys (e.g. `rc/components/Hero.astro` instead of `src/components/Hero.astro`), so directory status rollup failed and no `M`/`A`/etc. badges were shown.

- Updated dependencies [150f2c8]
  - @shellular/protocol@0.0.15

## 0.0.30

### Patch Changes

- abef551: fix: session attach/detach with multi-client support, lazy session snapshots, and runtime cleanup

  - Add AI_SESSION_ATTACH and AI_SESSION_DETACH for explicit session lifecycle management
  - Implement session snapshots with revision tracking for efficient state sync
  - Add runtime cleanup timers to prevent memory leaks from idle sessions
  - Fix race condition preventing reuse of destroyed ACP runtimes
  - Fix root path resolution to not inadvertently form double-slash paths

- Updated dependencies [abef551]
  - @shellular/protocol@0.0.14

## 0.0.29

### Patch Changes

- 6e8bd00: fix: prevent daemon startup failures from repeatedly registering hosts.

  the daemon now runs host registration as a startup preflight before launching the PM2-managed process, and PM2 restarts are capped to avoid infinite restart loops on rapid failures.

## 0.0.28

### Patch Changes

- f5f5baf: feat: make CLI the source of truth for keep track of agent state, and enable Cursor
- Updated dependencies [f5f5baf]
  - @shellular/protocol@0.0.13

## 0.0.27

### Patch Changes

- 7f0ce79: chore: update acp sdk to 0.22.1
- Updated dependencies [7f0ce79]
  - @shellular/protocol@0.0.12

## 0.0.26

### Patch Changes

- 7e305dd: fix: use correct shell arguments for terminal spawning on windows

## 0.0.25

### Patch Changes

- edb6d8b: feat: agents installation

## 0.0.24

### Patch Changes

- e223074: feat: add Hermes support in beta
- Updated dependencies [e223074]
  - @shellular/protocol@0.0.11

## 0.0.23

### Patch Changes

- 5dea8fe: fix: spawn pty and resolve commands via login shell to pick up current PATH

## 0.0.22

### Patch Changes

- ad5944a: fix: support binary sending for http browser proxy

## 0.0.21

### Patch Changes

- 9aaa503: fix: ask for permission on client join, session load & prompt

## 0.0.20

### Patch Changes

- b1e47c5: fix: pagination in opencode sdk causes infinite loop, fixed

  the problem was opencode SDK, so i removed pagination logic in opencode.

  if you set start to even 999 in opencode it still returns values, so basically it keeps on returning values

## 0.0.19

### Patch Changes

- Updated dependencies [5fc49c9]
  - @shellular/protocol@0.0.10

## 0.0.18

### Patch Changes

- 23cc546: feat: add msgs for agent chat attachment, and call /host/register endpoint now
- Updated dependencies [23cc546]
  - @shellular/protocol@0.0.9

## 0.0.17

### Patch Changes

- b7b52dc: improve host registration, update pm2 to v7, remove unused deps & add daemon restart

## 0.0.16

### Patch Changes

- 61c5965: fix

## 0.0.15

### Patch Changes

- Updated dependencies [08bdf89]
  - @shellular/protocol@0.0.8

## 0.0.14

### Patch Changes

- 4358476: fix: handle crashes, wrap listeners in try catch, don't send to disconnected clients & add github cli ACP

## 0.0.13

### Patch Changes

- 117a1d8: feat(acp): add support for Pi agent
- Updated dependencies [117a1d8]
  - @shellular/protocol@0.0.7

## 0.0.12

### Patch Changes

- 0445ef3: fix: remove old shit ai code, and use ACP
- Updated dependencies [0445ef3]
  - @shellular/protocol@0.0.6

## 0.0.11

### Patch Changes

- 68e650e: fix(sysmon): fix sysmon stats
- Updated dependencies [68e650e]
  - @shellular/protocol@0.0.5

## 0.0.10

### Patch Changes

- 745d948: fix: improve clients command printing & add client --delete option

## 0.0.9

### Patch Changes

- 776c3d1: feat: accept device info from client during connection
- Updated dependencies [776c3d1]
  - @shellular/protocol@0.0.4

## 0.0.8

### Patch Changes

- 4409fb6: fix: add username to hostinfo & remove npm_config_prefix from PTY env
- Updated dependencies [4409fb6]
  - @shellular/protocol@0.0.3

## 0.0.7

### Patch Changes

- d6ec5f0: feat: move all protocol in @shellular/protocol package
- Updated dependencies [d6ec5f0]
  - @shellular/protocol@0.0.2

## 0.0.6

### Patch Changes

- 9bd2c77: fix(boot-lock): lock file should be per user, not OS
- 6e35696: fix: use headless xterm to correctly restore terminals

## 0.0.5

### Patch Changes

- cd2fcaf: fix(vs code ext): directly install the .vsix file in prod instead of building it always
- a94e4d3: ask users to approve unknown clients, and added a --unknown-clients flag to control approbal policy
- 7da4a1d: Updated ai protocol

## 0.0.4

### Patch Changes

- c9ab125: fix: don't accept sensitive messages in plain text

## 0.0.3

### Patch Changes

- f39bfcf: feat: check for updates every 24hrs on startup

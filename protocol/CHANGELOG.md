# @shellular/protocol

## 0.0.27

- d0fae9c: fix(protocol): auth is now mandatory for new versions
  - NOTE: THIS VERSION WAS MANUALLY PUBLISHED BY me (github.com/biraj21)
  - removed user field from ClientInfoSchema
  - and hence also removed ClientInfoRequestSchema
  - added ServerCloseCodeAndReason object to use between client, server and CLI
  - this breaks things in CLI, so the CLI build should fail. CLI will be updated in the next multi-region PR to use this protocol change.

## 0.0.26

### Patch Changes

- a46e941: feat(users): implement account allowlist management and user identity handling

## 0.0.25

### Patch Changes

- 0c27774: feat: add support for Grok Build

## 0.0.24

### Patch Changes

- 8e319ac: refactor: rename AiBackend to AgentId, and add codex shell install method

## 0.0.23

### Patch Changes

- d8770d1: feat(git): push, pull, stage, unstage, commit, pull, push

## 0.0.22

### Patch Changes

- 6067397: feat: show shellular version in app, and update
  - Add `showSelfUpdateLogs` function to display self-update logs with live streaming of the latest log file.
  - Introduce `runSelfUpdate` function to handle self-update execution, ensuring proper detachment from the parent process.
  - Update `pm2` and remove unused dependencies
  - Add startup and unstartup sub-commands to manage Shellular CLI daemon startup (wrapper over PM2)
  - Add `--no-qr` option to the CLI to not show QR code
  - Extend protocol with new message types for host updates and results, including schemas for validation.
  - Modify session information to include CLI version and update availability status.

## 0.0.21

### Patch Changes

- 025d3a9: feat: monitor active claude code and codex sessions and send it to FE so that they can be shown under active sessions for seamless handoff

## 0.0.20

### Patch Changes

- 7a6d943: Update ACP SDK usage to the latest session configuration API and remove the obsolete session model selector bridge.
- 87ef273: feat: implement portless URL mapping in ports handler (https://portless.sh/)

## 0.0.19

### Patch Changes

- c18c131: fix: make sure npx spawn for ACP work on windows, and pin ACP sdk version to 0.23.0 since the unstable model setting was removed

## 0.0.18

### Patch Changes

- 1415220: feat: allow users to add custom ACP agents

## 0.0.17

### Patch Changes

- d71b927: feat: implement git commit file diff functionality with message schemas

## 0.0.16

### Patch Changes

- a55f9a3: feat: add git log and commit files functionality with message schemas

## 0.0.15

### Patch Changes

- 150f2c8: feat: a flag to show hidden files

## 0.0.14

### Patch Changes

- abef551: fix: session attach/detach with multi-client support, lazy session snapshots, and runtime cleanup
  - Add AI_SESSION_ATTACH and AI_SESSION_DETACH for explicit session lifecycle management
  - Implement session snapshots with revision tracking for efficient state sync
  - Add runtime cleanup timers to prevent memory leaks from idle sessions
  - Fix race condition preventing reuse of destroyed ACP runtimes
  - Fix root path resolution to not inadvertently form double-slash paths

## 0.0.13

### Patch Changes

- f5f5baf: feat: make CLI the source of truth for keep track of agent state, and enable Cursor

## 0.0.12

### Patch Changes

- 7f0ce79: chore: update acp sdk to 0.22.1

## 0.0.11

### Patch Changes

- e223074: feat: add Hermes support in beta

## 0.0.10

### Patch Changes

- 5fc49c9: fix: add some constraints to ClientInfoSchema

## 0.0.9

### Patch Changes

- 23cc546: feat: add msgs for agent chat attachment, and call /host/register endpoint now

## 0.0.8

### Patch Changes

- 08bdf89: feat: add copilot to protocol

## 0.0.7

### Patch Changes

- 117a1d8: feat(acp): add support for Pi agent

## 0.0.6

### Patch Changes

- 0445ef3: fix: remove old shit ai code, and use ACP

## 0.0.5

### Patch Changes

- 68e650e: fix(sysmon): fix sysmon stats

## 0.0.4

### Patch Changes

- 776c3d1: feat: accept device info from client during connection

## 0.0.3

### Patch Changes

- 4409fb6: fix: add username to hostinfo & remove npm_config_prefix from PTY env

## 0.0.2

### Patch Changes

- d6ec5f0: feat: move all protocol in @shellular/protocol package

# shellular

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

# Shellular CLI

Host agent for [Shellular](https://shellular.dev) — connects your dev machine to the Shellular relay so you can access your environment remotely from the Shellular app.

## Features

- **Terminal** — full PTY sessions; terminals survive CLI reconnects and are only killed on clean exit
- **Filesystem** — browse, read, write, rename, and delete files within the working directory
- **Ports** — list and kill processes by port
- **Proxy** — HTTP and WebSocket proxying to local services
- **System monitor** — CPU, memory, and battery streaming
- **Agents VIA ACP** — use agents like Codex, Claude Code, OpenCode, Copilot CLI, Pi
- **End-to-end encryption** — all messages are encrypted with libsodium; the pairing key is exchanged out-of-band via QR code

## Requirements

- Node.js 20+
- macOS / Linux / Windows

## Quick Start

```bash
npx shellular
```

Scan the QR code printed in the terminal with the Shellular app to connect.

By default, every unknown client must be approved in the terminal before it can connect.

To run Shellular in the background instead:

```bash
npx shellular start
```

When Shellular is running in daemon mode, unknown clients are not approved interactively. Use `npx shellular clients` to review and approve them.

Stop the background host when you are done:

```bash
npx shellular stop
```

> **Note:** Only one instance of Shellular can run at a time per machine. Starting a second instance will exit immediately.

### Commands

| Command             | Description                                     |
| ------------------- | ----------------------------------------------- |
| `shellular`         | Run Shellular in the foreground                 |
| `shellular start`   | Start the background host and print the QR code |
| `shellular stop`    | Stop the background host                        |
| `shellular restart` | Restart the background host                     |
| `shellular status`  | Show host status, PID, restart count, and logs  |
| `shellular logs`    | Stream background host logs                     |
| `shellular clients` | Review and approve known client devices         |

### Options

| Flag                         | Default                     | Description                                                                              |
| ---------------------------- | --------------------------- | ---------------------------------------------------------------------------------------- |
| `--server <url>`             | `wss://api.shellular.dev`   | Relay server WebSocket URL                                                               |
| `--dir <path>`               | OS home directory (`$HOME`) | Root directory exposed to the client                                                     |
| `--unknown-clients <policy>` | `requires-approval`         | How unknown clients are handled: `always-reject`, `always-allow`, or `requires-approval` |

`--unknown-clients` only applies to clients that are not already in the local approvals file.

- `requires-approval` is the default. In foreground mode, the CLI asks for approval in the terminal when a new client tries to connect.
- In daemon mode, `requires-approval` records the client as pending and rejects the connection until you approve it with `shellular clients`.
- `always-allow` accepts unknown clients immediately and does not modify the approvals file.
- `always-reject` rejects unknown clients immediately and does not modify the approvals file.

## Development

```bash
pnpm install
pnpm run dev                          # foreground watch mode
pnpm run dev -- --dir ~/projects      # foreground with custom options
pnpm run dev -- start                 # background host
pnpm run dev -- start --dir ~/projects # background host with custom options
```

### Build

```bash
pnpm run build   # tsc + tsup
```

Output goes to `dist/`. Entry point: `dist/main.js`.

### Format

```bash
pnpm run format
```

## Security

- Filesystem access is restricted to the `--dir` root (path traversal is rejected).
- Files larger than **2 MB** are rejected on read.

## License

AGPL-3.0-only

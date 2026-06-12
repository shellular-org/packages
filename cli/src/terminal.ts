import path from "node:path";
import {
	MsgType,
	type TerminalAttachResultMsg,
	type TerminalClosedMsg,
	type TerminalCreateResultMsg,
	type TerminalListResultMsg,
} from "@shellular/protocol";
import { SerializeAddon } from "@xterm/addon-serialize";
import XtermHeadless, { type Terminal } from "@xterm/headless";
import nodePty from "node-pty";

import { config } from "./config";
import type { Connection } from "./connection";
import { logger } from "./logger";
import { mapGetOrInsert } from "./utils";

const { Terminal: HeadlessTerminal } = XtermHeadless;

interface TerminalEntry {
	pty: nodePty.IPty;
	shell: string;
	clientId: string;
	headless: Terminal;
	serializer: SerializeAddon;
}

const shell =
	config.PLATFORM === "win32"
		? "powershell.exe"
		: process.env.SHELL || "/bin/bash";
const shellPath = path.basename(shell);

// Spawn the shell as a login shell so it loads the user's profile/rc files.
// POSIX shells use `-l`; PowerShell has no login concept (it auto-loads profiles),
// so we pass `-NoLogo` to suppress the startup banner.
const shellArgs = config.PLATFORM === "win32" ? ["-NoLogo"] : ["-l"];

const terminals = new Map<string, Map<string, TerminalEntry>>();
const MAX_REPLAY_SCROLLBACK = 2000;

// Environment variables stripped from a spawned terminal's environment.
//
// The daemon inherits its environment from whatever shell ran `shellular start`
// (copied verbatim by getPm2Env in daemon.ts), so shell/version-manager state can
// leak in and then get re-inherited by every login shell we spawn. A login shell
// (`-l`) rebuilds this state from the user's rc files anyway, so the inherited
// copies are at best redundant and at worst make tools complain — e.g. nvm prints
// "not compatible with npm_config_prefix" before every prompt when it sees a
// pre-set npm_config_prefix. Dropping these lets nvm's init script start clean.
//
// Scoped to the nvm family deliberately: NVM_DIR/NVM_BIN/NVM_INC are *outputs* of
// sourcing nvm.sh (which the rc file does on every login-shell spawn), not inputs
// nvm needs to find itself, so removing them does not break `nvm` in the terminal.
// We intentionally do NOT strip VIRTUAL_ENV/CONDA_* — those don't error out, and a
// user may rely on a pre-activated env; they can re-activate per-terminal or via
// their rc file if they prefer.
const STRIPPED_ENV_VARS = [
	"npm_config_prefix", // nvm refuses to load when this is pre-set
	"NVM_DIR", // re-exported and re-sourced by the rc file on login
	"NVM_BIN", // derived by nvm.sh
	"NVM_INC", // derived by nvm.sh
	"NVM_CD_FLAGS",
];

let terminalCounter = 0;

// Active WebSocket connection to relay server — updated on every (re)connect, nulled on disconnect.
// PTY async callbacks (onData/onExit) route through this so they always reach
// the current connection rather than the one captured at spawn time.
let activeConn: Connection | null = null;

// PTYs persist like tmux sessions: once spawned they live until the shell exits,
// the client explicitly closes them, or the daemon process restarts. There is no
// idle/orphan TTL — a disconnected client's terminals are kept alive indefinitely
// so they can be reattached later, matching tmux's "sessions live as long as the
// server" semantics.

function getClientTerminals(clientId: string): Map<string, TerminalEntry> {
	return mapGetOrInsert(
		terminals,
		clientId,
		() => new Map<string, TerminalEntry>(),
	);
}

interface CreateTerminalOptions {
	clientId: string;
	rows: number;
	cols: number;
	cwd: string;
}

function createTerminal({
	clientId,
	rows,
	cols,
	cwd,
}: CreateTerminalOptions): TerminalEntry {
	// Strip leaked shell/version-manager state (see STRIPPED_ENV_VARS) so the
	// spawned login shell rebuilds it cleanly from the user's rc files instead of
	// inheriting a stale copy from the daemon's environment.
	const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
	for (const key of STRIPPED_ENV_VARS) {
		delete cleanEnv[key];
	}

	const pty = nodePty.spawn(shellPath, shellArgs, {
		name: "xterm-256color",
		cols,
		rows,
		cwd,
		env: cleanEnv,
	});

	const headless = new HeadlessTerminal({
		cols,
		rows,
		scrollback: MAX_REPLAY_SCROLLBACK,
		allowProposedApi: true,
	});
	const serializer = new SerializeAddon();
	headless.loadAddon(serializer);

	return {
		pty: pty,
		shell: shellPath,
		clientId,
		headless: headless,
		serializer,
	};
}

export function initTerminalHandler(conn: Connection, workDir: string) {
	// Track the current active connection so PTY async callbacks always use
	// the latest socket rather than the one captured at spawn time.
	activeConn = conn;

	conn.on(MsgType.TERMINAL_CREATE, (msg) => {
		const { clientId } = msg;

		const clientTerminals = getClientTerminals(clientId);

		const terminalId = `${msg.clientId}-term-${++terminalCounter}`;

		const cols = msg.data.cols ?? 80;
		const rows = msg.data.rows ?? 24;

		let terminal: TerminalEntry;
		try {
			terminal = createTerminal({
				clientId,
				rows,
				cols,
				cwd: msg.data.cwd ? path.resolve(workDir, msg.data.cwd) : workDir,
			});
		} catch (err) {
			logger.error("Failed to spawn PTY:", err);
			const respMsg: TerminalCreateResultMsg = {
				type: MsgType.TERMINAL_CREATE_RESULT,
				clientId,
				respTo: msg.id,
				error: err instanceof Error ? err.message : "Failed to spawn PTY",
			};
			conn.send(respMsg);
			return;
		}

		const respMsg: TerminalCreateResultMsg = {
			type: MsgType.TERMINAL_CREATE_RESULT,
			clientId,
			respTo: msg.id,
			data: { terminalId, shell: shellPath },
		};

		// Respond with terminal ID and shell name
		conn.send(respMsg);

		clientTerminals.set(terminalId, terminal);

		terminal.headless.onTitleChange((title) => {
			activeConn?.send({
				type: MsgType.TERMINAL_TITLE,
				clientId: msg.clientId,
				data: { terminalId, title },
			});
		});

		// Send terminal output back to client and mirror it into the headless terminal.
		// Uses activeConn (not the closed-over conn) so output reaches the current
		// connection after a CLI or app reconnect.
		terminal.pty.onData((data) => {
			terminal.headless.write(data);
			activeConn?.send({
				type: MsgType.TERMINAL_DATA,
				clientId: msg.clientId,
				data: { terminalId, data },
			});
		});

		terminal.pty.onExit(({ exitCode }) => {
			clientTerminals.delete(terminalId);
			terminal.headless.dispose();
			const respMsg: TerminalClosedMsg = {
				type: MsgType.TERMINAL_CLOSED,
				clientId,
				data: { terminalId, exitCode },
			};
			activeConn?.send(respMsg);
		});
	});

	conn.on(MsgType.TERMINAL_LIST, (msg) => {
		const { clientId } = msg;

		const clientTerminals = getClientTerminals(clientId);
		const list = Array.from(clientTerminals.entries()).map(
			([terminalId, entry]) => ({
				terminalId,
				shell: entry.shell,
			}),
		);
		const respMsg: TerminalListResultMsg = {
			type: MsgType.TERMINAL_LIST_RESULT,
			clientId,
			respTo: msg.id,
			data: { terminals: list },
		};
		conn.send(respMsg);
	});

	conn.on(MsgType.TERMINAL_ATTACH, async (msg) => {
		const { clientId } = msg;

		const clientTerminals = getClientTerminals(clientId);

		const entry = clientTerminals.get(msg.data.terminalId);
		if (!entry) {
			const respMsg: TerminalAttachResultMsg = {
				type: MsgType.TERMINAL_ATTACH_RESULT,
				clientId,
				respTo: msg.id,
				error: "Terminal not found",
			};
			conn.send(respMsg);
			return;
		}
		const { terminalId, cols, rows } = msg.data;
		const nextCols = cols ?? 80;
		const nextRows = rows ?? 24;
		try {
			entry.pty.resize(nextCols, nextRows);
			entry.headless.resize(nextCols, nextRows);
		} catch {}

		const snapshot = entry.serializer.serialize();
		const respMsg: TerminalAttachResultMsg = {
			type: MsgType.TERMINAL_ATTACH_RESULT,
			clientId,
			respTo: msg.id,
			data: {
				terminalId,
				shell: entry.shell,
				snapshot: snapshot,
				snapshotFormat: "xterm-serialize",
				activeBuffer: entry.headless.buffer.active.type,
			},
		};
		conn.send(respMsg);
	});

	conn.on(MsgType.TERMINAL_DATA, (msg) => {
		const { clientId } = msg;

		const clientTerminals = getClientTerminals(clientId);
		const entry = clientTerminals.get(msg.data.terminalId);
		if (entry) {
			entry.pty.write(msg.data.data);
		}
	});

	conn.on(MsgType.TERMINAL_RESIZE, (msg) => {
		const { clientId } = msg;

		const clientTerminals = getClientTerminals(clientId);
		const entry = clientTerminals.get(msg.data.terminalId);
		if (!entry) {
			return;
		}

		try {
			entry.pty.resize(msg.data.cols, msg.data.rows);
			entry.headless.resize(msg.data.cols, msg.data.rows);
		} catch {}
	});

	conn.on(MsgType.TERMINAL_CLOSE, (msg) => {
		const { clientId } = msg;

		const clientTerminals = getClientTerminals(clientId);

		const entry = clientTerminals.get(msg.data.terminalId);
		if (entry) {
			entry.pty.kill();
			entry.headless.dispose();
			clientTerminals.delete(msg.data.terminalId);
			const respMsg: TerminalClosedMsg = {
				type: MsgType.TERMINAL_CLOSED,
				clientId,
				respTo: msg.id,
				data: { terminalId: msg.data.terminalId },
			};
			conn.send(respMsg);
		}
	});

	// On CLI disconnect, null out activeConn so PTY output isn't sent to a dead
	// socket. PTYs themselves are kept alive to survive CLI reconnects.
	conn.on("disconnected", () => {
		activeConn = null;
	});
}

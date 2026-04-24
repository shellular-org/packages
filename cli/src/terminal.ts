import os from "node:os";
import path from "node:path";

import { SerializeAddon } from "@xterm/addon-serialize";
import XtermHeadless, { type Terminal } from "@xterm/headless";

const { Terminal: HeadlessTerminal } = XtermHeadless;

import {
	MsgType,
	type TerminalAttachResultMsg,
	type TerminalClosedMsg,
	type TerminalCreateResultMsg,
	type TerminalListResultMsg,
} from "@shellular/protocol";
import chalk from "chalk";
import * as nodePty from "node-pty";
import type { Connection } from "./connection";
import { logger } from "./logger";
import { mapGetOrInsert } from "./utils";

interface TerminalEntry {
	pty: nodePty.IPty;
	shell: string;
	clientId: string;
	headless: Terminal;
	serializer: SerializeAddon;
}

const shell =
	os.platform() === "win32"
		? "powershell.exe"
		: process.env.SHELL || "/bin/bash";
const shellPath = path.basename(shell);

const terminals = new Map<string, Map<string, TerminalEntry>>();
const MAX_REPLAY_SCROLLBACK = 2000;

let terminalCounter = 0;

// Active WebSocket connection to relay server — updated on every (re)connect, nulled on disconnect.
// PTY async callbacks (onData/onExit) route through this so they always reach
// the current connection rather than the one captured at spawn time.
let activeConn: Connection | null = null;

// Tracks when a client disconnected so orphaned PTYs can be GC-ed after a TTL.
const orphanedSince = new Map<string, number>(); // clientId → timestamp (ms)
const ORPHAN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Hourly GC: kill PTYs whose client has been absent for longer than ORPHAN_TTL_MS.
const _orphanGcInterval = setInterval(
	() => {
		const now = Date.now();
		for (const [clientId, since] of orphanedSince) {
			if (now - since > ORPHAN_TTL_MS) {
				const clientTerminals = terminals.get(clientId);
				if (clientTerminals) {
					for (const [, entry] of clientTerminals) {
						try {
							entry.pty.kill();
						} catch {}
					}
					terminals.delete(clientId);
				}
				orphanedSince.delete(clientId);
				logger.log(
					chalk.red(
						`✓ GC: removed orphaned PTYs for client ${clientId} (TTL exceeded)\n`,
					),
				);
			}
		}
	},
	60 * 60 * 1000,
);
_orphanGcInterval.unref();

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
	const pty = nodePty.spawn(shellPath, [], {
		name: "xterm-256color",
		cols,
		rows,
		cwd,
		env: process.env,
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

		// Reattaching means the client is back — cancel any pending orphan TTL.
		orphanedSince.delete(clientId);

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

	// When a client disconnects, keep PTYs alive and start the orphan TTL.
	// PTYs are only killed on explicit terminal:close or after ORPHAN_TTL_MS.
	conn.on(MsgType.SESSION_CLIENT_LEFT, (msg) => {
		const { clientId } = msg.data;
		const termCount = terminals.get(clientId)?.size ?? 0;
		if (termCount > 0) {
			orphanedSince.set(clientId, Date.now());
			logger.log(
				chalk.yellow(
					`⏳ Client ${clientId} disconnected — keeping ${termCount} PTY(s) alive (TTL: 7 days)\n`,
				),
			);
		} else {
			logger.log(
				chalk.red(`✗ Client ${clientId} disconnected (no active terminals)\n`),
			);
		}
	});

	// When the app's client reconnects, cancel its orphan TTL.
	conn.on(MsgType.SESSION_CLIENT_JOINED, (msg) => {
		const { clientId } = msg.data;
		if (orphanedSince.has(clientId)) {
			orphanedSince.delete(clientId);
			logger.log(
				chalk.green(
					`✓ Client ${clientId} reconnected — orphan TTL cancelled, PTYs restored\n`,
				),
			);
		}
	});

	// On CLI disconnect, null out activeConn so PTY output isn't sent to a dead
	// socket. PTYs themselves are kept alive to survive CLI reconnects.
	conn.on("disconnected", () => {
		activeConn = null;
	});
}

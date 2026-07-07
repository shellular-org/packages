import { execFileSync } from "node:child_process";
import fs from "node:fs";
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
import { nanoid } from "nanoid";
import nodePty from "node-pty";

import { config } from "./config";
import type { Connection } from "./connection";
import { logger } from "./logger";
import {
	type PersistedTerminal,
	readPersistedTerminals,
	removeTerminal as removePersistedTerminal,
	writeTerminal,
} from "./terminal-store";
import { mapGetOrInsert } from "./utils";

const { Terminal: HeadlessTerminal } = XtermHeadless;

interface TerminalEntry {
	pty: nodePty.IPty;
	shell: string;
	clientId: string;
	headless: Terminal;
	serializer: SerializeAddon;
	/** Directory the terminal was spawned in; the live cwd is read from the OS. */
	cwd: string;
	title?: string;
	cols: number;
	rows: number;
	/** Debounce timer for persisting buffer snapshots (see scheduleSnapshot). */
	persistTimer?: ReturnType<typeof setTimeout>;
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

// Debounce for persisting a terminal's serialized buffer. Terminal output can be
// a flood of tiny writes; we only snapshot ~1s after it settles so restore has a
// recent buffer without rewriting the file on every keystroke.
const PERSIST_DEBOUNCE_MS = 1000;

// Printed after the restored scrollback so the user can see where the previous
// (now-dead) shell ended and the freshly-spawned one begins, like VS Code.
const RESTORE_MARKER =
	"\r\n\x1b[2m─── History restored (shell restarted) ───\x1b[0m\r\n";

// Neither node-pty nor xterm-headless exposes the shell's cwd, so read it from
// the OS via the pid: the /proc symlink on Linux, `lsof` on macOS. Returns null
// on failure so callers fall back to the last-known cwd.
function readProcessCwd(pid: number): string | null {
	try {
		if (process.platform === "linux") {
			return fs.readlinkSync(`/proc/${pid}/cwd`);
		}
		if (process.platform === "darwin") {
			// `lsof -a -d cwd -Fn -p <pid>` prints the cwd on a line prefixed with "n".
			const out = execFileSync(
				"lsof",
				["-a", "-d", "cwd", "-Fn", "-p", String(pid)],
				{ encoding: "utf-8" },
			);
			for (const line of out.split("\n")) {
				if (line.startsWith("n")) return line.slice(1);
			}
		}
	} catch {
		// Process may have exited, or lsof is unavailable/denied — fall back.
	}
	return null;
}

function toPersisted(
	entry: TerminalEntry,
	terminalId: string,
): PersistedTerminal {
	const liveCwd = readProcessCwd(entry.pty.pid);
	if (liveCwd) entry.cwd = liveCwd;
	return {
		clientId: entry.clientId,
		terminalId,
		shell: entry.shell,
		cwd: entry.cwd,
		title: entry.title,
		snapshot: entry.serializer.serialize(),
		cols: entry.cols,
		rows: entry.rows,
		updatedAt: new Date().toISOString(),
	};
}

/** Persist this terminal's current buffer/cwd/title immediately. */
function persistTerminal(entry: TerminalEntry, terminalId: string): void {
	writeTerminal(toPersisted(entry, terminalId));
}

/** Debounced persist, coalescing bursts of PTY output into one snapshot write. */
function scheduleSnapshot(entry: TerminalEntry, terminalId: string): void {
	if (entry.persistTimer) clearTimeout(entry.persistTimer);
	entry.persistTimer = setTimeout(() => {
		entry.persistTimer = undefined;
		persistTerminal(entry, terminalId);
	}, PERSIST_DEBOUNCE_MS);
	entry.persistTimer.unref?.();
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
		cwd,
		cols,
		rows,
	};
}

// Registers the PTY/headless event handlers for a terminal and inserts it into
// the in-memory map. Shared by fresh creates and restored terminals so both
// stream output, track titles, persist snapshots, and clean up on exit
// identically. `emitCreated`, when set, is called once the entry is wired (used
// by create to send TERMINAL_CREATE_RESULT after registration).
function wireTerminal(
	entry: TerminalEntry,
	terminalId: string,
	clientTerminals: Map<string, TerminalEntry>,
): void {
	const { clientId } = entry;
	clientTerminals.set(terminalId, entry);

	// A terminal that exists is a terminal to restore: persist it immediately so
	// even a crash before the first snapshot debounce still brings it back.
	persistTerminal(entry, terminalId);

	entry.headless.onTitleChange((title) => {
		entry.title = title;
		activeConn?.send({
			type: MsgType.TERMINAL_TITLE,
			clientId,
			data: { terminalId, title },
		});
		scheduleSnapshot(entry, terminalId);
	});

	// Send terminal output back to client and mirror it into the headless terminal.
	// Uses activeConn (not a closed-over conn) so output reaches the current
	// connection after a CLI or app reconnect.
	entry.pty.onData((data) => {
		entry.headless.write(data);
		activeConn?.send({
			type: MsgType.TERMINAL_DATA,
			clientId,
			data: { terminalId, data },
		});
		scheduleSnapshot(entry, terminalId);
	});

	entry.pty.onExit(({ exitCode }) => {
		if (entry.persistTimer) clearTimeout(entry.persistTimer);
		clientTerminals.delete(terminalId);
		entry.headless.dispose();
		// The shell exited on its own — the user is done with it, so drop the
		// persisted copy. It must not come back on the next restart.
		removePersistedTerminal(terminalId);
		const respMsg: TerminalClosedMsg = {
			type: MsgType.TERMINAL_CLOSED,
			clientId,
			data: { terminalId, exitCode },
		};
		activeConn?.send(respMsg);
	});
}

export function initTerminalHandler(conn: Connection, workDir: string) {
	// Track the current active connection so PTY async callbacks always use
	// the latest socket rather than the one captured at spawn time.
	activeConn = conn;

	conn.on(MsgType.TERMINAL_CREATE, (msg) => {
		const { clientId } = msg;

		const clientTerminals = getClientTerminals(clientId);

		// Random suffix (not a counter) so ids are unique across process restarts:
		// a fresh process has no memory of a previous run's ids, and restored
		// terminals keep their original ids — a counter starting from 0 could
		// otherwise re-mint an id that a restored terminal already holds.
		const terminalId = `${msg.clientId}-term-${nanoid(4)}`;

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

		wireTerminal(terminal, terminalId, clientTerminals);
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
			entry.cols = nextCols;
			entry.rows = nextRows;
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
			entry.cols = msg.data.cols;
			entry.rows = msg.data.rows;
		} catch {}
		// Persist the new geometry so a restored terminal comes back correctly sized.
		scheduleSnapshot(entry, msg.data.terminalId);
	});

	conn.on(MsgType.TERMINAL_CLOSE, (msg) => {
		const { clientId } = msg;

		const clientTerminals = getClientTerminals(clientId);

		const entry = clientTerminals.get(msg.data.terminalId);
		if (entry) {
			if (entry.persistTimer) clearTimeout(entry.persistTimer);
			entry.pty.kill();
			entry.headless.dispose();
			clientTerminals.delete(msg.data.terminalId);
			// User explicitly closed it — drop the persisted copy so it does not
			// come back on the next restart.
			removePersistedTerminal(msg.data.terminalId);
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

/**
 * Re-spawns the terminals that were alive (and not closed/killed) when the CLI
 * last exited. Call ONCE at daemon startup, before clients connect. Each stored
 * terminal is restored into a fresh login shell in its last cwd, with its saved
 * scrollback replayed as history followed by a restore marker — VS Code style.
 * The dead shell's live process state cannot survive a restart; only the buffer,
 * cwd, and title carry over.
 */
export function restoreTerminals(workDir: string): void {
	const persisted = readPersistedTerminals();
	if (persisted.length === 0) return;

	let restored = 0;
	for (const saved of persisted) {
		// If the saved cwd no longer exists (deleted between runs), fall back to
		// the daemon's working dir rather than failing to spawn.
		const cwd = saved.cwd && fs.existsSync(saved.cwd) ? saved.cwd : workDir;

		let entry: TerminalEntry;
		try {
			entry = createTerminal({
				clientId: saved.clientId,
				rows: saved.rows,
				cols: saved.cols,
				cwd,
			});
		} catch (err) {
			logger.error(
				`Failed to restore terminal ${saved.terminalId}:`,
				err instanceof Error ? err.message : String(err),
			);
			// Drop the record we could not restore so it doesn't retry forever.
			removePersistedTerminal(saved.terminalId);
			continue;
		}

		// Seed the headless buffer with the saved scrollback, then a marker so the
		// user sees where the previous shell ended. This is written only to the
		// headless mirror (not the live pty) so it becomes scrollback the app
		// receives on attach; the fresh shell's own prompt follows underneath.
		if (saved.snapshot) entry.headless.write(saved.snapshot);
		entry.headless.write(RESTORE_MARKER);
		entry.title = saved.title;

		const clientTerminals = getClientTerminals(saved.clientId);
		wireTerminal(entry, saved.terminalId, clientTerminals);

		restored++;
	}

	if (restored > 0) {
		logger.log(`♻️  Restored ${restored} terminal(s) from previous session.`);
	}
}

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

import { config } from "@/config";
import type { HostConnection } from "@/connection";
import { logger } from "@/logger";
import { execFileAsync, mapGetOrInsert } from "@/utils";
import {
	type PersistedTerminal,
	readPersistedTerminals,
	removeTerminal as removePersistedTerminal,
	writeTerminal,
} from "./persistance";

const { Terminal: HeadlessTerminal } = XtermHeadless;

interface TerminalEntry {
	pty: nodePty.IPty;
	shell: string;
	clientId: string;
	headless: Terminal;
	serializer: SerializeAddon;
	/**
	 * Last-known working directory. Kept current by OSC 7 sequences the shell
	 * emits on each prompt (the accurate, push-based path — see wireCwdDetection),
	 * falling back to a periodic OS-level pid probe for shells without shell
	 * integration.
	 */
	cwd: string;
	/**
	 * True once the shell has reported its cwd via OSC 7. While true we trust the
	 * pushed value and skip the pid probe entirely, matching VS Code's split
	 * between CwdDetection (OSC, authoritative) and NaiveCwdDetection (poll).
	 */
	cwdFromOsc: boolean;
	/** Epoch ms of the last pid probe; throttles the fallback OS call. */
	cwdCheckedAt: number;
	title?: string;
	cols: number;
	rows: number;
	/** Debounce timer for persisting buffer snapshots (see scheduleSnapshot). */
	persistTimer?: ReturnType<typeof setTimeout>;
	/** Disposes the OSC 7 handler when the terminal exits. */
	oscDisposable?: { dispose(): void };
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
let activeConn: HostConnection | null = null;

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
const RESTORE_MARKER_TEXT = "─── History restored ───";
const RESTORE_MARKER = `\r\n\x1b[2m${RESTORE_MARKER_TEXT}\x1b[0m\r\n`;

// cwd detection, VS Code style. Two paths, in order of preference:
//
//   1. OSC 7 (wireCwdDetection) — the shell pushes its cwd on every prompt via
//      an escape sequence in the PTY stream. Accurate and event-driven; this is
//      what VS Code calls CwdDetection. Active whenever the user's shell has
//      shell integration (the default zsh/bash on modern macOS, fish, etc.).
//   2. Pid probe (readProcessCwd) — ask the OS for the shell process's cwd. Used
//      only as a fallback for shells that emit no OSC 7. This is VS Code's
//      NaiveCwdDetection. We run it OUT OF BAND (fire-and-forget, throttled) so a
//      slow probe never blocks the event loop — VS Code's own fallback is a
//      non-blocking syscall for the same reason.

// Reads the shell process's cwd from the OS by pid: the /proc symlink on Linux,
// `lsof` on macOS. Async so the macOS subprocess never blocks the event loop
// (freezing every terminal, sysmon, and the WS connection). Returns null on
// failure so callers keep the last-known cwd.
async function readProcessCwd(pid: number): Promise<string | null> {
	try {
		if (process.platform === "linux") {
			return await fs.promises.readlink(`/proc/${pid}/cwd`);
		}
		if (process.platform === "darwin") {
			// `lsof -a -d cwd -Fn -p <pid>` prints the cwd on a line prefixed with "n".
			const { stdout } = await execFileAsync("lsof", [
				"-a",
				"-d",
				"cwd",
				"-Fn",
				"-p",
				String(pid),
			]);
			for (const line of stdout.split("\n")) {
				if (line.startsWith("n")) return line.slice(1);
			}
		}
	} catch {
		// Process may have exited, or lsof is unavailable/denied — fall back.
	}
	return null;
}

// Parses the path out of an OSC 7 payload: `file://<host>/absolute/path`. The
// host segment (usually the local hostname or empty) is ignored; a bare path
// without the file:// scheme is accepted too, as some shells emit it. Returns
// null if it isn't a usable absolute path.
function parseOsc7Cwd(payload: string): string | null {
	try {
		if (payload.startsWith("file://")) {
			const cwd = decodeURIComponent(new URL(payload).pathname);
			return cwd || null;
		}
		if (payload.startsWith("/")) return payload;
	} catch {
		// Malformed URL — ignore.
	}
	return null;
}

// Registers the OSC 7 handler that keeps entry.cwd current from the shell's own
// prompt reports (the preferred, push-based path). Marks cwdFromOsc so the pid
// probe can bow out. Returns false so the sequence still passes to other
// handlers/the app.
function wireCwdDetection(entry: TerminalEntry): void {
	entry.oscDisposable = entry.headless.parser.registerOscHandler(7, (data) => {
		const cwd = parseOsc7Cwd(data);
		if (cwd) {
			entry.cwd = cwd;
			entry.cwdFromOsc = true;
		}
		return false;
	});
}

// Minimum spacing between pid probes. Only used for shells without OSC 7; a
// slightly stale cwd only matters at restore time (rare), so throttling is safe.
const CWD_PROBE_INTERVAL_MS = 5000;

// Fire-and-forget refresh of entry.cwd via the pid probe, for shells that don't
// push cwd over OSC 7. Throttled and non-blocking: it updates entry.cwd for the
// NEXT snapshot rather than the current one, so the persist path never awaits a
// subprocess. No-op once OSC 7 has ever reported (we trust the pushed value).
function refreshCwdIfStale(entry: TerminalEntry): void {
	if (entry.cwdFromOsc) return;
	const now = Date.now();
	if (now - entry.cwdCheckedAt < CWD_PROBE_INTERVAL_MS) return;
	entry.cwdCheckedAt = now;
	void readProcessCwd(entry.pty.pid).then((liveCwd) => {
		// A late OSC 7 report may have arrived while the probe ran; don't clobber it.
		if (liveCwd && !entry.cwdFromOsc) entry.cwd = liveCwd;
	});
}

function toPersisted(
	entry: TerminalEntry,
	terminalId: string,
): PersistedTerminal {
	// Kick off a background cwd refresh for the fallback path; the current cwd
	// (from OSC 7 or a prior probe) is what gets written now.
	refreshCwdIfStale(entry);
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
		cwdFromOsc: false,
		// 0 forces a live-cwd probe on the first persist (create/restore/wire).
		cwdCheckedAt: 0,
		cols,
		rows,
	};
}

// Registers the PTY/headless event handlers for a terminal and inserts it into
// the in-memory map. Shared by fresh creates and restored terminals so both
// stream output, track titles, persist snapshots, and clean up on exit
// identically.
function wireTerminal(
	entry: TerminalEntry,
	terminalId: string,
	clientTerminals: Map<string, TerminalEntry>,
	// Restored terminals persist their own (marker-free) snapshot before wiring
	// and pass true here to skip this immediate re-persist. Skipping avoids baking
	// the presentational RESTORE_MARKER into the file, where it would otherwise
	// stack a fresh marker onto the buffer on every subsequent restart.
	skipInitialPersist = false,
): void {
	const { clientId } = entry;
	clientTerminals.set(terminalId, entry);

	// Start listening for the shell's OSC 7 cwd reports (preferred path). Wired
	// before the pty streams so the first prompt's report is captured.
	wireCwdDetection(entry);

	// A terminal that exists is a terminal to restore: persist it immediately so
	// even a crash before the first snapshot debounce still brings it back.
	if (!skipInitialPersist) persistTerminal(entry, terminalId);

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
		entry.oscDisposable?.dispose();
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

export function initTerminalHandler(conn: HostConnection, workDir: string) {
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
			entry.oscDisposable?.dispose();
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

		entry.title = saved.title;
		const clientTerminals = getClientTerminals(saved.clientId);

		// Seed the headless buffer with the saved scrollback, then a marker so the
		// user sees where the previous shell ended. Both are written only to the
		// headless mirror (not the live pty) so they become scrollback the app
		// receives on attach; the fresh shell's own prompt follows underneath.
		if (saved.snapshot) {
			entry.headless.write(saved.snapshot);
		}
		entry.headless.write(RESTORE_MARKER);

		// skipInitialPersist: the snapshot we'd write here still holds the freshly
		// injected marker; leave persistence to the first real PTY output.
		wireTerminal(entry, saved.terminalId, clientTerminals, true);

		restored++;
	}

	if (restored > 0) {
		logger.log(`♻️  Restored ${restored} terminal(s) from previous session.`);
	}
}

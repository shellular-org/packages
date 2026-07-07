import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { config } from "@/config";
import { logger } from "@/logger";

// One JSON file per terminal under config.TERMINALS_DIR. The file mirrors a live
// terminal: it is written when the terminal is created and whenever its buffer
// snapshot is refreshed, and deleted when the terminal is closed or its shell
// exits. On daemon boot, whatever files remain are the terminals that were alive
// and NOT killed — those get restored (VS Code style: buffer + cwd + title into
// a fresh shell; the dead PTY's live process state cannot survive a restart).

const PersistedTerminalSchema = z.object({
	clientId: z.string(),
	terminalId: z.string(),
	shell: z.string(),
	cwd: z.string(),
	title: z.string().optional(),
	/** xterm-serialize snapshot of the scrollback buffer. */
	snapshot: z.string(),
	cols: z.number(),
	rows: z.number(),
	updatedAt: z.string(),
});

export type PersistedTerminal = z.infer<typeof PersistedTerminalSchema>;

// Map a terminalId to a safe filename. terminalId is `${clientId}-term-N`; the
// clientId is arbitrary, so replace anything outside a conservative set. The raw
// ids are stored inside the JSON, so restore never parses the filename back.
function fileNameFor(terminalId: string): string {
	const safe = terminalId.replace(/[^a-zA-Z0-9._-]/g, "_");
	return `${safe}.json`;
}

function filePathFor(terminalId: string): string {
	return path.join(config.TERMINALS_DIR, fileNameFor(terminalId));
}

/** Writes (or overwrites) the persisted record for a single terminal. */
export function writeTerminal(entry: PersistedTerminal): void {
	try {
		const tmp = `${filePathFor(entry.terminalId)}.tmp`;
		const final = filePathFor(entry.terminalId);
		// Write-then-rename so a crash mid-write can't leave a half-written file
		// that later fails to parse (and gets dropped on restore).
		fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
		fs.renameSync(tmp, final);
	} catch (err) {
		logger.error(
			`Failed to persist terminal ${entry.terminalId}:`,
			err instanceof Error ? err.message : String(err),
		);
	}
}

/** Removes the persisted record for a terminal (on close or shell exit). */
export function removeTerminal(terminalId: string): void {
	try {
		fs.rmSync(filePathFor(terminalId), { force: true });
	} catch (err) {
		logger.error(
			`Failed to remove persisted terminal ${terminalId}:`,
			err instanceof Error ? err.message : String(err),
		);
	}
}

/**
 * Reads every persisted terminal. Files that are missing/corrupt are skipped
 * (and cleaned up) so a schema change or partial write can never crash restore.
 */
export function readPersistedTerminals(): PersistedTerminal[] {
	let files: string[];
	try {
		files = fs
			.readdirSync(config.TERMINALS_DIR)
			.filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}

	const result: PersistedTerminal[] = [];
	for (const file of files) {
		const full = path.join(config.TERMINALS_DIR, file);
		try {
			const parsed = PersistedTerminalSchema.safeParse(
				JSON.parse(fs.readFileSync(full, "utf-8")),
			);
			if (parsed.success) {
				result.push(parsed.data);
			} else {
				// Invalid / stale-schema file: drop it so it doesn't linger.
				fs.rmSync(full, { force: true });
			}
		} catch {
			fs.rmSync(full, { force: true });
		}
	}
	return result;
}

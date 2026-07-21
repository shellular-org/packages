import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { promisify } from "node:util";

/** Promise-returning execFile; resolves `{ stdout, stderr }`, rejects on nonzero exit. */
export const execFileAsync = promisify(execFile);

export function mapGetOrInsert<K, V>(
	map: Map<K, V>,
	key: K,
	defaultValueFn: () => V,
): V {
	let value = map.get(key);
	if (!value) {
		value = defaultValueFn();
		map.set(key, value);
	}

	return value;
}

/**
 * Resolves which of `commands` exist on PATH, in a single shell.
 *
 * Results are deliberately NOT cached: an agent the user uninstalls has to stop
 * being reported immediately, and a cache would keep serving a stale answer.
 * The cost is kept down instead by (a) doing one shell spawn for the whole set
 * rather than one per command, and (b) being async, so the ~170ms a login shell
 * takes to source the user's rc chain never blocks the event loop.
 */
export async function commandsExist(
	commands: string[],
): Promise<Map<string, boolean>> {
	const unique = [...new Set(commands)];
	const result = new Map(unique.map((command) => [command, false]));
	if (unique.length === 0) return result;

	// The exit status is meaningless here and MUST be ignored: the script's status
	// is that of its last `command -v`, so a batch whose final entry is missing
	// exits 1 even when every other lookup succeeded. execFileAsync rejects on a
	// nonzero exit but still carries the output, so read stdout off the error too
	// — discarding it would report every agent as missing.
	const runCapturingStdout = async (
		file: string,
		args: string[],
	): Promise<string> => {
		try {
			const { stdout } = await execFileAsync(file, args);
			return stdout;
		} catch (err) {
			const stdout = (err as { stdout?: string | Buffer } | null)?.stdout;
			if (typeof stdout === "string") return stdout;
			if (Buffer.isBuffer(stdout)) return stdout.toString("utf-8");
			// Spawn itself failed (missing shell, broken rc) — nothing resolved.
			return "";
		}
	};

	if (process.platform === "win32") {
		// `where` accepts multiple names and prints the paths it resolves; it exits
		// nonzero when any name is missing, hence the same stdout-on-error handling.
		const stdout = await runCapturingStdout("where", unique);
		const lines = stdout.toLowerCase();
		for (const command of unique) {
			result.set(command, lines.includes(command.toLowerCase()));
		}
		return result;
	}

	// One login shell for the whole batch: each hit echoes its own name. The login
	// shell (`-lc`) is what makes this see PATH entries added after the daemon
	// started (Homebrew, nvm). `command -v` is a POSIX builtin.
	const script = unique
		.map(
			(command) => `command -v ${command} >/dev/null 2>&1 && echo ${command}`,
		)
		.join("; ");
	const shell = process.env.SHELL || "/bin/sh";
	const stdout = await runCapturingStdout(shell, ["-lc", script]);
	for (const line of stdout.split("\n")) {
		const name = line.trim();
		if (result.has(name)) result.set(name, true);
	}
	return result;
}

export function commandExists(command: string): boolean {
	try {
		if (process.platform === "win32") {
			const result = spawnSync("where", [command], {
				stdio: "ignore",
				shell: false,
			});
			return result.status === 0;
		}
		// Run inside a login shell so it searches the current PATH (including
		// anything added after the daemon started, e.g. Homebrew, nvm).
		const shell = process.env.SHELL || "/bin/sh";
		const result = spawnSync(shell, ["-lc", `command -v ${command}`], {
			stdio: "ignore",
			shell: false,
		});
		return result.status === 0;
	} catch {
		return false;
	}
}

export function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && "code" in err;
}

export function flatten<T>(arr: readonly (readonly T[])[]): T[] {
	const result: T[] = [];

	for (const inner of arr) {
		result.push(...inner);
	}

	return result;
}

export function getFileSize(filePath: string): number {
	try {
		return fs.statSync(filePath).size;
	} catch {
		return 0;
	}
}

export function streamFile(
	filePath: string,
	startAt: number,
	stream: NodeJS.WriteStream,
) {
	let offset = startAt;
	let hasData = offset > 0;

	const readNewData = () => {
		const size = getFileSize(filePath);
		if (size < offset) {
			offset = 0;
		}
		if (size <= offset) {
			return;
		}

		const reader = fs.createReadStream(filePath, {
			start: offset,
			end: size - 1,
		});
		offset = size;
		hasData = true;
		reader.pipe(stream, { end: false });
	};

	readNewData();
	const timer = setInterval(readNewData, 500);
	return {
		stop: () => {
			clearInterval(timer);
		},
		get hasData() {
			return hasData;
		},
	};
}

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

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

export function commandExists(command: string): boolean {
	try {
		if (process.platform === "win32") {
			const result = spawnSync("where", [command], {
				stdio: "ignore",
				shell: false,
			});
			return result.status === 0;
		}
		// Run `which` inside a login shell so it searches the current PATH
		// (including anything added after the daemon started, e.g. Homebrew, nvm).
		const shell = process.env.SHELL || "/bin/sh";
		const result = spawnSync(shell, ["-lc", `which ${command}`], {
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

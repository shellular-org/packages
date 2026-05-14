import { spawnSync } from "node:child_process";

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
			const result = spawnSync("where", [command], { stdio: "ignore", shell: false });
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

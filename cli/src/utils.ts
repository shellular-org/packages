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
		const checker = process.platform === "win32" ? "where" : "which";
		const result = spawnSync(checker, [command], {
			stdio: "ignore",
			shell: false,
		});
		return result.status === 0;
	} catch {
		return false;
	}
}

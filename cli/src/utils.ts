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

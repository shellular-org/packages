import type { z } from "zod";

interface Entry<T> {
	value: T;
	/** Epoch ms after which the entry is considered stale. */
	expiresAt: number;
}

export interface LocalCacheOptions<T> {
	/** Time-to-live in milliseconds before a stored value is treated as expired. */
	ttlMs: number;
	/**
	 * Optional schema. When provided, values are validated on read; a value that
	 * fails validation is treated as a cache miss (and evicted), so a schema
	 * change can never hand back a malformed cached value.
	 */
	schema?: z.ZodType<T>;
}

/**
 * A tiny in-memory key→value cache with per-entry TTL and optional zod
 * validation. Lives for the lifetime of the process only (no disk), so it is
 * safe for long-running daemons: entries expire and are re-fetched instead of
 * being frozen for the life of the process.
 */
export class LocalCache<T> {
	private readonly store = new Map<string, Entry<T>>();
	private readonly ttlMs: number;
	private readonly schema?: z.ZodType<T>;
	private readonly inFlight = new Map<string, Promise<T | undefined>>();

	constructor(options: LocalCacheOptions<T>) {
		this.ttlMs = options.ttlMs;
		this.schema = options.schema;
	}

	/** Returns the cached value if present and unexpired, otherwise undefined. */
	get(key: string): T | undefined {
		const entry = this.store.get(key);
		if (!entry) {
			return undefined;
		}

		if (Date.now() >= entry.expiresAt) {
			this.store.delete(key);
			return undefined;
		}

		if (this.schema) {
			const parsed = this.schema.safeParse(entry.value);
			if (!parsed.success) {
				this.store.delete(key);
				return undefined;
			}

			return parsed.data;
		}

		return entry.value;
	}

	/** Stores a value under `key`, expiring after the configured TTL. */
	set(key: string, value: T): void {
		this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
	}

	/**
	 * Returns the cached value if fresh; otherwise invokes `fetcher`, caches its
	 * result, and returns it. Concurrent callers for the same key share one
	 * in-flight fetch. If the fetch resolves to `undefined`, nothing is cached.
	 */
	async getOrFetch(
		key: string,
		fetcher: () => Promise<T | undefined>,
	): Promise<T | undefined> {
		const cached = this.get(key);
		if (cached !== undefined) {
			return cached;
		}

		const existing = this.inFlight.get(key);
		if (existing) {
			return existing;
		}

		const promise = fetcher()
			.then((value) => {
				if (value !== undefined) this.set(key, value);
				return value;
			})
			.finally(() => {
				this.inFlight.delete(key);
			});

		this.inFlight.set(key, promise);
		return promise;
	}

	/** Drops a single entry (or all entries when no key is given). */
	clear(key?: string): void {
		if (key === undefined) {
			this.store.clear();
		} else {
			this.store.delete(key);
		}
	}
}

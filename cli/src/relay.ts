import fs from "node:fs";

import {
	type HostTokenResponse,
	HostTokenResponseSchema,
} from "@shellular/protocol";
import { z } from "zod";

import { config } from "@/config";
import { LocalCache } from "@/local-cache";
import { logger } from "@/logger";
import { ServerUrl } from "@/server-url";

/**
 * Relay resolution: the CLI no longer connects straight to a fixed server. It
 * asks central for the live relay URLs, measures latency to each, and connects to
 * the fastest — with the chosen relay cached on disk so subsequent boots skip
 * probing. Central also mints a short-lived host token (verifying machineId/hostId/
 * platform) that the relay trusts; that token is cached in memory and reused across
 * reconnects until it nears expiry, so a reconnect doesn't re-hit central unless it
 * has to. A permanent verification failure surfaces as a HostResolveError so the
 * caller can stop rather than retry.
 *
 * Relays are identified purely by URL — central returns a live set of relay URLs.
 *
 * `--server` now means the CENTRAL API base (e.g. https://server.shellular.dev); the
 * relay to actually open a WebSocket to comes out of this module.
 */

/** Number of latency samples per relay; we take the median. */
const PROBE_SAMPLES = 4;
/** Per-probe timeout — a relay slower than this is treated as unreachable. */
const PROBE_TIMEOUT_MS = 2000;

/**
 * A permanent, non-retryable failure from central: the request itself is wrong
 * (host verification failed, bad user-agent, malformed identity — HTTP 4xx). The
 * reconnect loop must NOT back off and retry these, because nothing about waiting
 * will change the outcome — the CLI's identity simply doesn't check out. Contrast
 * with transient errors (network, 5xx, relay down) which should retry.
 */
export class HostResolveError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "HostResolveError";
	}
}

const RelayCacheEntrySchema = z.object({
	/** The chosen (fastest at last probe) relay's public URL. */
	url: z.string(),
	/**
	 * Measured RTTs (ms) per relay URL from the last probe. This doubles as the set
	 * of *known* relays: a relay in the fresh server list but absent here is one we've
	 * never measured, so it must be probed before we can trust the cached ranking.
	 */
	latencies: z.record(z.string(), z.number()),
	measuredAt: z.number(),
});
type RelayCacheEntry = z.infer<typeof RelayCacheEntrySchema>;

/**
 * The disk cache is keyed by central server URL (the `--server` flag). Each
 * server publishes its own set of relays, so a relay chosen for server A is
 * meaningless for server B — keying by server means switching `--server` never
 * reuses the previous server's relay ranking; it re-probes against the new
 * server's relays. Entries for other servers are preserved on write.
 */
const RelayCacheSchema = z.record(z.string(), RelayCacheEntrySchema);
type RelayCache = z.infer<typeof RelayCacheSchema>;

export interface ResolvedRelay {
	/** Ordered fastest-first list of relay WebSocket URLs to try (for failover). */
	relayWsUrls: string[];
	/**
	 * The host token to present to the relay — either freshly minted or reused from
	 * the in-memory cache while still valid for at least the refresh margin.
	 */
	token: string;
}

export interface HostIdentity {
	hostId: string;
	machineId: string;
	platform: string;
}

/** Turn a relay's public origin (http/https/ws/wss) into its /cli WebSocket URL. */
function toRelayCliWsUrl(relayUrl: string): string {
	return new ServerUrl(relayUrl).toWebSocketUrl();
}

/** Turn a relay's public origin into its /health probe URL (http/https). */
function toRelayHealthUrl(relayUrl: string): string {
	return new ServerUrl(relayUrl).toApiUrl({ path: "/health" });
}

/** Read the whole server-keyed cache map, or an empty map if missing/corrupt. */
function readRelayCacheMapFromDisk(): RelayCache {
	try {
		const raw = fs.readFileSync(config.RELAY_CACHE_FILE, "utf-8");
		const parsed = RelayCacheSchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : {};
	} catch {
		return {};
	}
}

/** The cached relay choice for a specific central server, or null. */
function readRelayCache(centralApiUrl: string): RelayCacheEntry | null {
	return readRelayCacheMapFromDisk()[centralApiUrl] ?? null;
}

/**
 * Persist the relay choice for `centralApiUrl`, merging into the existing map so
 * other servers' cached choices survive. Keyed by server so switching `--server`
 * doesn't clobber (or reuse) another server's ranking.
 */
function writeRelayCache(centralApiUrl: string, entry: RelayCacheEntry): void {
	try {
		const map = readRelayCacheMapFromDisk();
		map[centralApiUrl] = entry;
		fs.writeFileSync(config.RELAY_CACHE_FILE, JSON.stringify(map, null, 2));
	} catch (err) {
		logger.debug("Failed to write relay cache:", err);
	}
}

function isCacheFresh(cache: RelayCacheEntry | null): cache is RelayCacheEntry {
	return !!cache && Date.now() - cache.measuredAt < config.RELAY_CACHE_TTL_MS;
}

/** One timed HTTPS/HTTP GET to a relay's /health. Returns RTT ms, or null on failure. */
async function probeOnce(healthUrl: string): Promise<number | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	const start = performance.now();
	try {
		const res = await fetch(healthUrl, { signal: controller.signal });
		if (!res.ok) {
			return null;
		}

		// Drain the (tiny) body so the connection completes cleanly.
		await res.text().catch(() => undefined);
		return performance.now() - start;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** Median RTT to a relay across PROBE_SAMPLES timed requests, or null if all failed. */
async function measureRelay(relayUrl: string): Promise<number | null> {
	const healthUrl = toRelayHealthUrl(relayUrl);
	const samples: number[] = [];
	for (let i = 0; i < PROBE_SAMPLES; i++) {
		const rtt = await probeOnce(healthUrl);
		if (rtt !== null) {
			samples.push(rtt);
		}
	}

	if (samples.length === 0) {
		return null;
	}

	samples.sort((a, b) => a - b);
	const mid = Math.floor(samples.length / 2);
	return samples.length % 2 === 0
		? (samples[mid - 1] + samples[mid]) / 2
		: samples[mid];
}

/**
 * Probe all relays concurrently and return them ordered fastest-first. Relays that
 * fail every probe are dropped. If none respond, falls back to the server-provided
 * order so the CLI is never left with an empty list.
 */
async function rankRelaysByLatency(
	relayUrls: string[],
): Promise<{ ordered: string[]; latencies: Record<string, number> }> {
	const measurements = await Promise.all(
		relayUrls.map(async (url) => ({ url, rtt: await measureRelay(url) })),
	);

	const reachable = measurements.filter((m) => m.rtt !== null) as {
		url: string;
		rtt: number;
	}[];

	const latencies: Record<string, number> = {};
	for (const m of reachable) {
		latencies[m.url] = Math.round(m.rtt);
	}

	if (reachable.length === 0) {
		logger.warn("No relay responded to latency probes; using server order.");
		return { ordered: relayUrls, latencies };
	}

	reachable.sort((a, b) => a.rtt - b.rtt);
	return { ordered: reachable.map((m) => m.url), latencies };
}

async function fetchTokenAndRelays(
	centralApiUrl: string,
	identity: HostIdentity,
): Promise<HostTokenResponse["data"]> {
	const url = new ServerUrl(centralApiUrl).toApiUrl({
		path: "/host/token",
	});
	logger.debug(`Getting relays & token from server...`);
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"User-Agent": `shellular/${config.VERSION}`,
		},
		body: JSON.stringify(identity),
	});

	const json = await res.json().catch(() => null);

	if (!res.ok) {
		const message =
			(json &&
				typeof json === "object" &&
				"error" in json &&
				String((json as { error: unknown }).error)) ||
			`Relay resolve failed: ${res.status} ${res.statusText}`;
		// 4xx means the request is wrong and will stay wrong (host verification
		// failed, bad user-agent, malformed identity) — surface it as permanent so
		// the caller stops instead of retrying forever. 5xx / network fall through
		// to a plain Error, which the reconnect loop treats as transient.
		if (res.status >= 400 && res.status < 500) {
			throw new HostResolveError(message, res.status);
		}
		throw new Error(message);
	}

	const parsed = HostTokenResponseSchema.safeParse(json);
	if (!parsed.success) {
		throw new Error(
			`Relay resolve returned an unexpected response shape (status ${res.status}).`,
		);
	}
	return parsed.data.data;
}

/**
 * The relay-side host-token TTL. The server echoes `ttlSeconds`, but
 * the cache lifetime is derived from this constant so it stays fixed per instance.
 */
const TOKEN_TTL_MS = 600_000;
/**
 * Re-mint once the token has less than this much life left, so a token handed to
 * the caller is always valid for at least this long — covering clock skew and the
 * round-trip to the relay so it never expires mid-connect. Baked into the cache
 * TTL below: `get()` misses (→ re-mint) once the token is within this window.
 */
const TOKEN_REFRESH_MARGIN_MS = 10_000;

/**
 * In-memory host-token cache, keyed by hostId. The token is a short-lived secret,
 * so it lives in memory only (never on disk) — a cold boot just re-mints, which is
 * cheap. The cache TTL is the real token TTL minus the refresh margin, so a hit is
 * always good for at least TOKEN_REFRESH_MARGIN_MS more; past that `get()` returns
 * a miss and we mint fresh. The relay list rides along so the two never drift.
 */
const tokenCache = new LocalCache<{ token: string; relays: string[] }>({
	ttlMs: TOKEN_TTL_MS - TOKEN_REFRESH_MARGIN_MS,
});

/**
 * Drop the cached token so the next `resolveRelay` mints a fresh one. Call this
 * when a connection is rejected for an auth reason (the relay closed with
 * HOST_AUTH_FAILED / the token was expired or invalid) — the cached token is the
 * suspect, so discard it rather than re-presenting it.
 */
export function invalidateTokenCache(): void {
	tokenCache.clear();
}

/**
 * Resolve the relay(s) to connect to plus a valid host token.
 *
 * Token: reused from the in-memory cache while it's still valid for at least the
 * refresh margin; otherwise minted fresh from central (which verifies the host).
 * Relay ranking: disk-cached — a fresh cache reuses the ranking (fast boot, no
 * probing); a stale one triggers a concurrent probe of all live relays, picking
 * the fastest and persisting the choice. The returned list is ordered fastest-first
 * so the caller can fail over to the next relay on connect error.
 */
export async function resolveTokenAndRelay(
	serverUrl: string,
	identity: HostIdentity,
): Promise<ResolvedRelay> {
	// Get a valid token + its relay list — from the in-memory cache when it's still
	// good, otherwise minted fresh from central. The relay list always rides with
	// the token it was minted alongside, so the two never drift apart.
	const { token, relays } = await getTokenAndRelays(serverUrl, identity);
	if (relays.length === 0) {
		throw new Error("No relays are available.");
	}

	const diskCache = readRelayCache(serverUrl);

	// Fast path — reuse the cached ranking without probing, but ONLY when nothing
	// about the fleet has changed in a way that could alter the choice:
	//   1. cache is still fresh (within TTL),
	//   2. the cached pick is still offered by the server (not retired/rotated out),
	//   3. the server isn't offering any relay we've never measured — a brand-new
	//      relay could be faster than our current pick, so it must be probed first.
	// Any of these failing falls through to a re-probe. We order the (possibly
	// shrunk) fresh list by cached latency so failover stays fastest-first.
	if (
		isCacheFresh(diskCache) &&
		relays.includes(diskCache.url) &&
		!hasUnknownRelay(relays, diskCache.latencies)
	) {
		return {
			relayWsUrls: orderByCachedLatency(relays, diskCache.latencies).map(
				toRelayCliWsUrl,
			),
			token,
		};
	}

	// Re-probe: cache expired, first run for this server, the cached pick is gone, or
	// the server introduced a relay we haven't measured. Probe all live relays
	// concurrently and re-rank fastest-first — the new relay is evaluated alongside
	// the rest, so it wins if it's actually faster.
	const { ordered, latencies } = await rankRelaysByLatency(relays);
	const best = ordered[0];
	writeRelayCache(serverUrl, {
		url: best,
		latencies,
		measuredAt: Date.now(),
	});
	logger.debug(
		`Resolved relay: ${best}; latencies: ${JSON.stringify(latencies)}`,
	);

	return {
		relayWsUrls: ordered.map(toRelayCliWsUrl),
		token,
	};
}

/**
 * Return a usable host token and its relay list — reused from the in-memory cache
 * while it's still valid for at least the refresh margin, otherwise minted fresh
 * from central (which verifies the host identity). Concurrent callers for the same
 * host share one in-flight mint. Only mints when needed, so a stale relay ranking
 * alone never costs a mint.
 */
async function getTokenAndRelays(
	serverUrl: string,
	identity: HostIdentity,
): Promise<{ token: string; relays: string[] }> {
	const value = await tokenCache.getOrFetch(identity.hostId, async () => {
		const data = await fetchTokenAndRelays(serverUrl, identity);
		return { token: data.token, relays: data.relays };
	});

	// getOrFetch only returns undefined when the fetcher does; ours always resolves
	// to a value or throws (HostResolveError / network Error), so this is defensive.
	if (!value) {
		throw new Error("Failed to obtain a host token.");
	}
	return value;
}

/**
 * True if the server is offering any relay we have no cached latency for — i.e. a
 * relay we've never probed. Its speed is unknown, so it could beat the cached pick;
 * seeing one forces a re-probe so it's actually evaluated.
 */
function hasUnknownRelay(
	relays: string[],
	latencies: Record<string, number>,
): boolean {
	return relays.some((url) => !(url in latencies));
}

/**
 * Order the fresh relay list fastest-first using cached latencies (no re-probing).
 * Only called on the fast path, where every offered relay is known — but any relay
 * somehow missing a latency sorts last rather than being dropped, so the list is
 * never truncated. Ties/unknowns keep their input order (stable sort).
 */
function orderByCachedLatency(
	relays: string[],
	latencies: Record<string, number>,
): string[] {
	return [...relays].sort(
		(a, b) =>
			(latencies[a] ?? Number.POSITIVE_INFINITY) -
			(latencies[b] ?? Number.POSITIVE_INFINITY),
	);
}

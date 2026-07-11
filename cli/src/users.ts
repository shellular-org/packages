import fs from "node:fs";

import type { ClientInfo } from "@shellular/protocol";
import { z } from "zod";

import { config } from "@/config";
import { LocalCache } from "@/local-cache";
import { logger } from "@/logger";
import { isErrnoException } from "@/utils";

const AllowedUsersStoreSchema = z.array(z.string());

/** Sorted, normalized, de-duplicated list of allowed account entries. */
export type AllowedUsersStore = z.infer<typeof AllowedUsersStoreSchema>;

/**
 * An allowlist entry is either an account email or a stable account user ID.
 * We distinguish them by the presence of `@`: emails always contain one and
 * user IDs (e.g. `u_abc123…`) never do.
 */
export type AllowedUserKind = "email" | "id";

export function classifyEntry(value: string): AllowedUserKind {
	return value.includes("@") ? "email" : "id";
}

/**
 * Emails are compared case-insensitively: an allowlist that rejects
 * `Biraj@Example.com` while accepting `biraj@example.com` would be a lockout
 * waiting to happen, and mail providers treat the domain as case-insensitive
 * regardless. User IDs are opaque and case-sensitive, so they are only trimmed.
 */
export function normalizeEntry(value: string): string {
	const trimmed = value.trim();
	return classifyEntry(trimmed) === "email" ? trimmed.toLowerCase() : trimmed;
}

// The allowlist is consulted on every join. Without a cache, connection
// requests and drive one synchronous disk read + JSON parse per attempt
const ALLOWED_USERS_TTL_MS = 60_000;
const ALLOWED_USERS_KEY = "allowed-users";
const allowedUsersCache = new LocalCache<AllowedUsersStore>({
	ttlMs: ALLOWED_USERS_TTL_MS,
	schema: AllowedUsersStoreSchema,
});

/**
 * Cached read of the allowlist. Serves from memory when fresh; otherwise reads
 * the file once and caches it. This is the read every consumer should use — a
 * flood of connection attempts can't turn into a flood of disk reads, and
 * concurrent joins share a single in-flight read.
 */
export async function readAllowedUsers(): Promise<AllowedUsersStore> {
	const cached = await allowedUsersCache.getOrFetch(
		ALLOWED_USERS_KEY,
		readAllowedUsersFromFile,
	);
	return cached ?? [];
}

async function readAllowedUsersFromFile(): Promise<AllowedUsersStore> {
	try {
		const raw = await fs.promises.readFile(config.USERS_FILE, "utf-8");
		const parsed = AllowedUsersStoreSchema.safeParse(JSON.parse(raw));
		if (!parsed.success) {
			logger.warn("Failed to parse users allowlist file.");
			return [];
		}

		// Normalize on read as well as write: the file is user-editable, and a
		// hand-added `Foo@Bar.com` must not silently fail to match.
		return sortUnique(parsed.data.map(normalizeEntry).filter(Boolean));
	} catch (err) {
		if (isErrnoException(err) && err.code === "ENOENT") {
			// No file yet just means no allowlist — not an error.
			return [];
		}

		logger.error(
			"Failed to read allowed users file:",
			err instanceof Error ? err.message : String(err),
		);
		return [];
	}
}

export async function writeAllowedUsers(
	entries: AllowedUsersStore,
): Promise<void> {
	const normalized = sortUnique(entries.map(normalizeEntry).filter(Boolean));
	await fs.promises.writeFile(
		config.USERS_FILE,
		JSON.stringify(normalized, null, 2),
	);
	// Drop the cache so a subsequent read in *this* process (e.g. the CLI
	// re-reading right after `add`) reflects the write immediately. Other
	// processes (the daemon) still catch up within the TTL.
	allowedUsersCache.clear(ALLOWED_USERS_KEY);
}

/** Returns `false` when the entry was already present. */
export async function addAllowedUser(value: string): Promise<boolean> {
	const normalized = normalizeEntry(value);
	const entries = await readAllowedUsers();
	if (entries.includes(normalized)) {
		return false;
	}

	await writeAllowedUsers([...entries, normalized]);
	return true;
}

/** Returns `false` when the entry was not in the allowlist. */
export async function removeAllowedUser(value: string): Promise<boolean> {
	const normalized = normalizeEntry(value);
	const entries = await readAllowedUsers();
	if (!entries.includes(normalized)) {
		return false;
	}

	await writeAllowedUsers(entries.filter((entry) => entry !== normalized));
	return true;
}

/**
 * Whether the allowlist is switched on. An empty allowlist means "don't gate",
 * which is what every pre-existing install has — so adding this feature changes
 * nothing until the host opts in by adding their first entry.
 */
export async function isUserAllowlistActive(): Promise<boolean> {
	return (await readAllowedUsers()).length > 0;
}

export type UserGateResult =
	| { allowed: true }
	| { allowed: false; reason: "unauthenticated" | "not-allowlisted" };

/**
 * Gates a joining client by account identity. This runs *before* the per-device
 * approval store: a host who allowlists their account expects it to cover every
 * one of their devices, and a host who revokes it expects that to evict devices
 * previously approved by clientId.
 *
 * A client matches if EITHER its account email OR its stable user ID is in the
 * allowlist. The user ID match is what lets one entry cover an account whose
 * devices signed in with different linked-provider emails.
 *
 * With the allowlist active, a client that proved no identity (legacy
 * unauthenticated path) can never satisfy it, so it is rejected.
 */
export async function checkUserGate(
	clientInfo: ClientInfo,
): Promise<UserGateResult> {
	const allowed = await readAllowedUsers();
	if (allowed.length === 0) {
		return { allowed: true };
	}

	const user = clientInfo.user;
	if (!user) {
		return { allowed: false, reason: "unauthenticated" };
	}

	const matches =
		allowed.includes(normalizeEntry(user.email)) ||
		allowed.includes(normalizeEntry(user.id));

	return matches
		? { allowed: true }
		: { allowed: false, reason: "not-allowlisted" };
}

function sortUnique(entries: string[]): string[] {
	return [...new Set(entries)].sort();
}

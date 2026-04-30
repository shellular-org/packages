import fs from "node:fs";

import type { ClientInfo } from "@shellular/protocol";
import { z } from "zod";

import { config } from "@/config";
import { logger } from "@/logger";

const KnownClientSchema = z.object({
	clientId: z.string(),
	hostId: z.string().optional(),
	platform: z.string(),
	appVersion: z.string(),
	deviceModel: z.string().optional(),
	deviceIsEmulator: z.boolean().optional(),
	deviceManufacturer: z.string().optional(),
	firstSeen: z.string(),
	lastSeen: z.string(),
	approved: z.boolean(),
});

const KnownClientsStoreSchema = z.record(z.string(), KnownClientSchema);

/** Keyed by clientId for O(1) lookup */
export type KnownClientsStore = z.infer<typeof KnownClientsStoreSchema>;

export function readKnownClients(): KnownClientsStore {
	try {
		if (!fs.existsSync(config.CLIENTS_FILE)) {
			return {};
		}

		const parsed = KnownClientsStoreSchema.safeParse(
			JSON.parse(fs.readFileSync(config.CLIENTS_FILE, "utf-8")),
		);
		return parsed.success ? parsed.data : {};
	} catch (err) {
		logger.error(
			"Failed to read known clients file:",
			err instanceof Error ? err.message : String(err),
		);
		return {};
	}
}

export function writeKnownClients(clients: KnownClientsStore): void {
	fs.writeFileSync(config.CLIENTS_FILE, JSON.stringify(clients, null, 2));
}

export function deleteKnownClient(clientId: string): boolean {
	const clients = readKnownClients();
	if (!(clientId in clients)) {
		return false;
	}

	delete clients[clientId];
	writeKnownClients(clients);
	return true;
}

/**
 * Returns `true` if the client is approved, `false` if explicitly rejected,
 * or `null` if the client is not yet known.
 */
export function getClientApproval(clientId: string): boolean | null {
	const client = readKnownClients()[clientId];
	if (!client) {
		return null;
	}

	return client.approved;
}

export function upsertClient(info: ClientInfo, approved: boolean): void {
	const clients = readKnownClients();
	const now = new Date().toISOString();
	const existing = clients[info.clientId];

	clients[info.clientId] = existing
		? {
				...existing,
				...info,
				lastSeen: now,
				approved,
			}
		: {
				...info,
				firstSeen: now,
				lastSeen: now,
				approved,
			};
	writeKnownClients(clients);
}

import { getOrRegisterHostId } from "@/config";
import { logger } from "@/logger";
import { ServerUrl } from "@/server-url";

export type PreStartOptions = {
	server: string;
};

export type PreStartResult = {
	hostId: string;
};

export async function preStart(
	options: PreStartOptions,
): Promise<PreStartResult> {
	try {
		const serverUrl = new ServerUrl(options.server);
		const hostId = await getOrRegisterHostId(serverUrl);
		return { hostId };
	} catch (err) {
		logger.error(
			"Error with host registration:",
			err instanceof Error ? err.message : String(err),
		);
		throw err;
	}
}

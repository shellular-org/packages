import { z } from "zod";

export const HostTokenResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({
		token: z.string(),
		/** Token lifetime in seconds, echoed so the CLI caches it in memory. */
		ttlSeconds: z.number().optional(),
		/** Live relay public URLs, self-registered with central. */
		relays: z.array(z.string()),
	}),
});
export type HostTokenResponse = z.infer<typeof HostTokenResponseSchema>;

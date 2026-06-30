import { z } from "zod";

import { MsgType } from "@/base";

// ─── App → CLI: trigger a self-update ────────────────────────────────────────

export const HostUpdateMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.HOST_UPDATE),
	clientId: z.string(),
	data: z.object({}).optional(),
});
export type HostUpdateMsg = z.infer<typeof HostUpdateMsgSchema>;

// ─── CLI → App: self-update progress / result ────────────────────────────────

export const HostUpdateStatusSchema = z.enum([
	"starting",
	"updating",
	"restarting",
	"error",
]);
export type HostUpdateStatus = z.infer<typeof HostUpdateStatusSchema>;

export const HostUpdateResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.HOST_UPDATE_RESULT),
	clientId: z.string(),
	respTo: z.string().optional(),
	data: z.object({
		status: HostUpdateStatusSchema,
		/** Human-readable detail, e.g. the install method or an error message. */
		message: z.string().optional(),
	}),
});
export type HostUpdateResultMsg = z.infer<typeof HostUpdateResultMsgSchema>;

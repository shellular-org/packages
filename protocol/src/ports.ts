import { z } from "zod";

import { MsgType } from "./base";

// ─── Incoming (client → CLI) ──────────────────────────────────────────────────

export const PortsListMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.PORTS_LIST),
	clientId: z.string(),
});
export type PortsListMsg = z.infer<typeof PortsListMsgSchema>;

export const PortsKillMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.PORTS_KILL),
	clientId: z.string(),
	data: z.object({
		port: z.number(),
	}),
});
export type PortsKillMsg = z.infer<typeof PortsKillMsgSchema>;

// ─── Outgoing (CLI → client) ──────────────────────────────────────────────────

export const PortsListResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.PORTS_LIST_RESULT),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			ports: z.array(
				z.object({
					port: z.number(),
					pid: z.number(),
					process: z.string(),
					address: z.string(),
					// Set only when the port is mapped to a portless
					// (https://portless.sh) `<name>.localhost` URL.
					portlessUrl: z.string().optional(),
				}),
			),
		})
		.optional(),
});
export type PortsListResultMsg = z.infer<typeof PortsListResultMsgSchema>;

export const PortsKillResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.PORTS_KILL_RESULT),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			port: z.number(),
			pid: z.number().nullable(),
		})
		.optional(),
});
export type PortsKillResultMsg = z.infer<typeof PortsKillResultMsgSchema>;

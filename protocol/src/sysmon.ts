import { z } from "zod";

import { MsgType } from "./base";

// ─── Incoming (client → CLI) ──────────────────────────────────────────────────

export const SysmonGetMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.SYSMON_GET),
	clientId: z.string(),
});
export type SysmonGetMsg = z.infer<typeof SysmonGetMsgSchema>;

// ─── Outgoing (CLI → client) ──────────────────────────────────────────────────

export const SysmonResultMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.SYSMON_RESULT),
	clientId: z.string().optional(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			cpu: z.object({
				model: z.string(),
				cores: z.number(),
				usage: z.number(),
			}),
			memory: z.object({
				total: z.number(),
				used: z.number(),
				free: z.number(),
			}),
			storage: z.array(
				z.object({
					mount: z.string(),
					total: z.number(),
					used: z.number(),
					free: z.number(),
				}),
			),
			uptime: z.number(),
		})
		.optional(),
});
export type SysmonResultMsg = z.infer<typeof SysmonResultMsgSchema>;

export const BatteryUpdateMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.BATTERY_UPDATE),
	clientId: z.string(),
	data: z.object({
		percentage: z.number(),
		charging: z.boolean(),
	}),
});
export type BatteryUpdateMsg = z.infer<typeof BatteryUpdateMsgSchema>;

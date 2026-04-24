import { z } from "zod";

import { PingMsgSchema } from "@/base";
import {
	SessionClientJoinResultMsgSchema,
	SessionHostMsgSchema,
} from "@/session";

export const HostToServerMsgSchema = z.discriminatedUnion("type", [
	PingMsgSchema,
	SessionHostMsgSchema,
	SessionClientJoinResultMsgSchema,
]);

export type HostToServerMsg = z.infer<typeof HostToServerMsgSchema>;

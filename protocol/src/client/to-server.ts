import { z } from "zod";

import { PingMsgSchema } from "@/base";

export const ClientToServerMsgSchema = z.discriminatedUnion("type", [
	PingMsgSchema,
]);

export type ClientToServerMsg = z.infer<typeof ClientToServerMsgSchema>;

import { z } from "zod";

import { SessionErrorMsgSchema, SessionHostedMsgSchema } from "@/session";

export const HostHandshakeRespMsgSchema = z.discriminatedUnion("type", [
	SessionHostedMsgSchema,
	SessionErrorMsgSchema,
]);
export type HostHandshakeMsg = z.infer<typeof HostHandshakeRespMsgSchema>;

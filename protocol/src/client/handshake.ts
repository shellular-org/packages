import { z } from "zod";

import { SessionErrorMsgSchema, SessionJoinedMsgSchema } from "@/session";

export const ClientHandshakeRespMsgSchema = z.discriminatedUnion("type", [
	SessionJoinedMsgSchema,
	SessionErrorMsgSchema,
]);
export type ClientHandshakeMsg = z.infer<typeof ClientHandshakeRespMsgSchema>;

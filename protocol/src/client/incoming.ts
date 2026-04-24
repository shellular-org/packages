import { z } from "zod";

import { PongMsgSchema } from "@/base";
import { HostToClientSchema } from "@/host/to-client";
import { SessionErrorMsgSchema, SessionJoinedMsgSchema } from "@/session";

export const ClientIncomingMsgSchema = z.discriminatedUnion("type", [
	SessionErrorMsgSchema,
	PongMsgSchema,
	HostToClientSchema,
	SessionJoinedMsgSchema,
]);

export type ClientIncomingMsg = z.infer<typeof ClientIncomingMsgSchema>;

import { z } from "zod";

import { ClientToHostMsgSchema } from "@/client/to-host";
import {
	SessionClientJoinedMsgSchema,
	SessionClientJoinMsgSchema,
	SessionClientLeftMsgSchema,
	SessionErrorMsgSchema,
} from "@/session";

export const HostIncomingMsgSchema = z.discriminatedUnion("type", [
	SessionErrorMsgSchema,
	SessionClientJoinMsgSchema,
	SessionClientJoinedMsgSchema,
	SessionClientLeftMsgSchema,
	ClientToHostMsgSchema,
]);

export type HostIncomingMsg = z.infer<typeof HostIncomingMsgSchema>;

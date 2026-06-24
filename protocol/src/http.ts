import { z } from "zod";

import { MsgType } from "./base";

// ─── HTTP proxy ───────────────────────────────────────────────────────────────

export const HttpRequestMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.HTTP_REQUEST),
	clientId: z.string(),
	data: z.object({
		method: z.string(),
		url: z.string(),
		headers: z.record(z.string(), z.string()).optional(),
		body: z.string().optional(),
		bodyEncoding: z.enum(["utf-8", "base64"]).optional(),
	}),
});
export type HttpRequestMsg = z.infer<typeof HttpRequestMsgSchema>;

export const HttpResponseStartMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.HTTP_RESPONSE_START),
	clientId: z.string(),
	respTo: z.string().optional(),
	data: z.object({
		requestId: z.string(),
		status: z.number(),
		statusText: z.string(),
		headers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
	}),
});
export type HttpResponseStartMsg = z.infer<typeof HttpResponseStartMsgSchema>;

export const HttpResponseDataMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.HTTP_RESPONSE_DATA),
	clientId: z.string(),
	data: z.object({
		requestId: z.string(),
		chunk: z.string(),
		index: z.number(),
	}),
});
export type HttpResponseDataMsg = z.infer<typeof HttpResponseDataMsgSchema>;

export const HttpResponseEndMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.HTTP_RESPONSE_END),
	clientId: z.string(),
	error: z.string().optional(),
	data: z.object({
		requestId: z.string(),
	}),
});
export type HttpResponseEndMsg = z.infer<typeof HttpResponseEndMsgSchema>;

// ─── WebSocket proxy ──────────────────────────────────────────────────────────

export const WsOpenMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.WS_OPEN),
	clientId: z.string(),
	data: z.object({
		url: z.string(),
		protocols: z.array(z.string()).optional(),
		headers: z.record(z.string(), z.string()).optional(),
	}),
});
export type WsOpenMsg = z.infer<typeof WsOpenMsgSchema>;

export const WsOpenedMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.WS_OPENED),
	clientId: z.string(),
	respTo: z.string().optional(),
	error: z.string().optional(),
	data: z
		.object({
			wsId: z.string().optional(),
			protocol: z.string().optional(),
		})
		.optional(),
});
export type WsOpenedMsg = z.infer<typeof WsOpenedMsgSchema>;

export const WsDataMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.WS_DATA),
	clientId: z.string(),
	data: z.object({
		wsId: z.string(),
		data: z.string(),
		encoding: z.enum(["utf-8", "base64"]),
	}),
});
export type WsDataMsg = z.infer<typeof WsDataMsgSchema>;
/** Alias for outgoing direction — same wire shape */
export type WsDataOutMsg = WsDataMsg;

export const WsCloseMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.WS_CLOSE),
	clientId: z.string(),
	data: z.object({
		wsId: z.string(),
		code: z.number().optional(),
		reason: z.string().optional(),
	}),
});
export type WsCloseMsg = z.infer<typeof WsCloseMsgSchema>;

export const WsClosedMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.WS_CLOSED),
	clientId: z.string(),
	data: z.object({
		wsId: z.string(),
		code: z.number().optional(),
		reason: z.string().optional(),
	}),
});
export type WsClosedMsg = z.infer<typeof WsClosedMsgSchema>;

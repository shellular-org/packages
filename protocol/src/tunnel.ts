import { z } from "zod";

import { MsgType } from "./base";

export const TCP_TUNNEL_VERSION = 1 as const;
export const TCP_TUNNEL_MAX_CONNECTIONS = 64;
export const TCP_TUNNEL_MAX_FRAME_BYTES = 64 * 1024;
export const TCP_TUNNEL_INITIAL_WINDOW_BYTES = 1024 * 1024;

const TunnelIdSchema = z.string().min(8).max(96);
const TunnelPortSchema = z.number().int().min(1).max(65_535);

export const TcpTunnelOpenMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.TCP_TUNNEL_OPEN),
	clientId: z.string(),
	data: z.object({
		tunnelId: TunnelIdSchema,
		host: z.enum(["localhost", "127.0.0.1", "::1", "0.0.0.0"]),
		port: TunnelPortSchema,
		initialWindowBytes: z
			.number()
			.int()
			.min(TCP_TUNNEL_MAX_FRAME_BYTES)
			.max(TCP_TUNNEL_INITIAL_WINDOW_BYTES),
	}),
});
export type TcpTunnelOpenMsg = z.infer<typeof TcpTunnelOpenMsgSchema>;

export const TcpTunnelOpenedMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.TCP_TUNNEL_OPENED),
	clientId: z.string(),
	respTo: z.string().optional(),
	data: z.object({
		tunnelId: TunnelIdSchema,
		windowBytes: z.number().int().min(0).max(TCP_TUNNEL_INITIAL_WINDOW_BYTES),
	}),
});
export type TcpTunnelOpenedMsg = z.infer<typeof TcpTunnelOpenedMsgSchema>;

export const TcpTunnelWindowMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.TCP_TUNNEL_WINDOW),
	clientId: z.string(),
	data: z.object({
		tunnelId: TunnelIdSchema,
		bytes: z.number().int().min(1).max(TCP_TUNNEL_INITIAL_WINDOW_BYTES),
	}),
});
export type TcpTunnelWindowMsg = z.infer<typeof TcpTunnelWindowMsgSchema>;

export const TcpTunnelEndMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.TCP_TUNNEL_END),
	clientId: z.string(),
	data: z.object({
		tunnelId: TunnelIdSchema,
	}),
});
export type TcpTunnelEndMsg = z.infer<typeof TcpTunnelEndMsgSchema>;

export const TcpTunnelCloseMsgSchema = z.object({
	id: z.string(),
	type: z.literal(MsgType.TCP_TUNNEL_CLOSE),
	clientId: z.string(),
	data: z.object({
		tunnelId: TunnelIdSchema,
	}),
});
export type TcpTunnelCloseMsg = z.infer<typeof TcpTunnelCloseMsgSchema>;

export const TcpTunnelClosedMsgSchema = z.object({
	id: z.string().optional(),
	type: z.literal(MsgType.TCP_TUNNEL_CLOSED),
	clientId: z.string(),
	respTo: z.string().optional(),
	error: z.string().max(512).optional(),
	data: z.object({
		tunnelId: TunnelIdSchema,
	}),
});
export type TcpTunnelClosedMsg = z.infer<typeof TcpTunnelClosedMsgSchema>;


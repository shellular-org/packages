import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	HostInfoSchema,
	MsgType,
	TCP_TUNNEL_INITIAL_WINDOW_BYTES,
	TcpTunnelOpenMsgSchema,
	TcpTunnelWindowMsgSchema,
} from "@shellular/protocol";

const openMessage = {
	id: "request-1",
	type: MsgType.TCP_TUNNEL_OPEN,
	clientId: "client-123",
	data: {
		tunnelId: "tunnel-123",
		host: "localhost",
		port: 8443,
		initialWindowBytes: TCP_TUNNEL_INITIAL_WINDOW_BYTES,
	},
};

describe("TCP tunnel protocol validation", () => {
	it("accepts an optional versioned capability without requiring it", () => {
		const base = {
			id: "host-123",
			hostname: "devbox",
			username: "developer",
			platform: "darwin",
			dir: "/workspace",
			machineId: "machine-123",
		};
		assert.equal(HostInfoSchema.safeParse(base).success, true);
		assert.equal(
			HostInfoSchema.safeParse({
				...base,
				capabilities: { tcpTunnel: 1, futureFeature: 2 },
			}).success,
			true,
		);
		assert.equal(
			HostInfoSchema.safeParse({
				...base,
				capabilities: { tcpTunnel: 2 },
			}).success,
			false,
		);
	});

	it("allows only loopback destinations and valid ports", () => {
		for (const host of ["localhost", "127.0.0.1", "::1", "0.0.0.0"]) {
			assert.equal(
				TcpTunnelOpenMsgSchema.safeParse({
					...openMessage,
					data: { ...openMessage.data, host },
				}).success,
				true,
			);
		}
		for (const host of ["192.168.1.4", "10.0.0.2", "example.com"]) {
			assert.equal(
				TcpTunnelOpenMsgSchema.safeParse({
					...openMessage,
					data: { ...openMessage.data, host },
				}).success,
				false,
			);
		}
		for (const port of [0, 65_536, 1.5]) {
			assert.equal(
				TcpTunnelOpenMsgSchema.safeParse({
					...openMessage,
					data: { ...openMessage.data, port },
				}).success,
				false,
			);
		}
	});

	it("bounds flow-control updates and rejects malformed tunnel IDs", () => {
		assert.equal(
			TcpTunnelWindowMsgSchema.safeParse({
				id: "window-1",
				type: MsgType.TCP_TUNNEL_WINDOW,
				clientId: "client-123",
				data: { tunnelId: "short", bytes: 1 },
			}).success,
			false,
		);
		assert.equal(
			TcpTunnelWindowMsgSchema.safeParse({
				id: "window-1",
				type: MsgType.TCP_TUNNEL_WINDOW,
				clientId: "client-123",
				data: {
					tunnelId: "tunnel-123",
					bytes: TCP_TUNNEL_INITIAL_WINDOW_BYTES + 1,
				},
			}).success,
			false,
		);
	});
});

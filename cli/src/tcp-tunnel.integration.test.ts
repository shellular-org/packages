import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import {
	MsgType,
	TCP_TUNNEL_INITIAL_WINDOW_BYTES,
} from "@shellular/protocol";
import sodium from "libsodium-wrappers";

const originalHome = process.env.HOME;
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "shellular-tunnel-test-"));
process.env.HOME = testHome;

const clientId = "client-tunnel-test";
const tunnelId = "tunnel-integration-1";
let echoServer: net.Server;
let echoPort = 0;
let hub: import("./connection-hub").ConnectionHub;
let messages: Array<Record<string, unknown>> = [];
let binaryFrames: Buffer[] = [];
let encryptionKey: Uint8Array;
const activeEchoSockets = new Set<net.Socket>();

before(async () => {
	const [configModule, encryptionModule, hubModule, proxyModule] =
		await Promise.all([
			import("./config"),
			import("./encryption"),
			import("./connection-hub"),
			import("./proxy"),
		]);
	configModule.ensureConfig();
	await encryptionModule.initEncryption();
	await sodium.ready;
	encryptionKey = sodium.from_base64(
		encryptionModule.getKeyBase64(),
		sodium.base64_variants.ORIGINAL,
	);

	echoServer = net.createServer((socket) => {
		activeEchoSockets.add(socket);
		socket.once("close", () => activeEchoSockets.delete(socket));
		socket.pipe(socket);
	});
	await new Promise<void>((resolve, reject) => {
		echoServer.once("error", reject);
		echoServer.listen(0, "127.0.0.1", () => resolve());
	});
	const address = echoServer.address();
	assert(address && typeof address === "object");
	echoPort = address.port;

	hub = new hubModule.ConnectionHub();
	hub.registerTransport({
		id: "test",
		kind: "remote",
		send: (message) => messages.push(message as Record<string, unknown>),
		sendBinary: (frame) => {
			binaryFrames.push(Buffer.from(frame));
			return true;
		},
		isOpen: () => true,
		getBufferedAmount: () => 0,
		close: () => undefined,
	});
	hub.acceptIncoming("test", {
		type: MsgType.SESSION_CLIENT_JOINED,
		data: {
			hostId: "host-tunnel-test",
			clientId,
			appVersion: "test",
			platform: "macos",
			deviceModel: "Test Mac",
			deviceIsEmulator: false,
			deviceManufacturer: "Test",
			user: { id: "user-test", email: "test@example.com" },
		},
	});
	proxyModule.initProxyHandler(hub.asHostConnection());
});

after(async () => {
	hub?.acceptIncoming("test", {
		type: MsgType.SESSION_CLIENT_LEFT,
		data: { clientId },
	});
	hub?.close();
	await new Promise<void>((resolve) => echoServer?.close(() => resolve()));
	process.env.HOME = originalHome;
	fs.rmSync(testHome, { force: true, recursive: true });
});

test("raw tunnels preserve ordered bytes, parallel flow, half-close, and disconnect cleanup", async () => {
	hub.acceptIncoming("test", {
		id: "open-1",
		type: MsgType.TCP_TUNNEL_OPEN,
		clientId,
		data: {
			tunnelId,
			host: "127.0.0.1",
			port: echoPort,
			initialWindowBytes: TCP_TUNNEL_INITIAL_WINDOW_BYTES,
		},
	});

	await waitFor(() =>
		messages.some(
			(message) =>
				message.type === MsgType.TCP_TUNNEL_OPENED &&
				(message.data as { tunnelId?: string }).tunnelId === tunnelId,
		),
	);

	const payload = Buffer.from("ordered encrypted echo");
	hub.emit("proxy:binary", encodeTunnelFrame(tunnelId, 0, payload));

	await waitFor(() => binaryFrames.length > 0);
	const decoded = decodeTunnelFrame(binaryFrames[0]);
	assert.equal(decoded.sequence, 0);
	assert.equal(decoded.tunnelId, tunnelId);
	assert.deepEqual(decoded.data, payload);
	await waitFor(() =>
		messages.some(
			(message) =>
				message.type === MsgType.TCP_TUNNEL_WINDOW &&
				(message.data as { bytes?: number }).bytes === payload.length,
		),
	);

	const parallelTunnelId = "tunnel-integration-2";
	hub.acceptIncoming("test", {
		id: "open-2",
		type: MsgType.TCP_TUNNEL_OPEN,
		clientId,
		data: {
			tunnelId: parallelTunnelId,
			host: "127.0.0.1",
			port: echoPort,
			initialWindowBytes: TCP_TUNNEL_INITIAL_WINDOW_BYTES,
		},
	});
	await waitFor(() =>
		messages.some(
			(message) =>
				message.type === MsgType.TCP_TUNNEL_OPENED &&
				(message.data as { tunnelId?: string }).tunnelId === parallelTunnelId,
		),
	);

	const parallelPayload = Buffer.from("parallel stream");
	hub.emit(
		"proxy:binary",
		encodeTunnelFrame(parallelTunnelId, 0, parallelPayload),
	);
	await waitFor(() =>
		binaryFrames.some((frame) => {
			const value = decodeTunnelFrame(frame);
			return value.tunnelId === parallelTunnelId;
		}),
	);

	hub.acceptIncoming("test", {
		id: "end-1",
		type: MsgType.TCP_TUNNEL_END,
		clientId,
		data: { tunnelId },
	});
	await waitFor(() =>
		messages.some(
			(message) =>
				message.type === MsgType.TCP_TUNNEL_CLOSED &&
				(message.data as { tunnelId?: string }).tunnelId === tunnelId,
		),
	);

	assert.equal(
		hub.acceptIncoming("test", {
			type: MsgType.SESSION_CLIENT_LEFT,
			data: { clientId },
		}),
		true,
	);
	await waitFor(() => activeEchoSockets.size === 0);
});

function encodeTunnelFrame(
	tunnelIdValue: string,
	sequence: number,
	data: Buffer,
): Buffer {
	const client = Buffer.from(clientId);
	const tunnel = Buffer.from(tunnelIdValue);
	const plaintext = Buffer.alloc(8 + client.length + tunnel.length + data.length);
	plaintext.writeUInt8(2, 0);
	plaintext.writeUInt8(client.length, 1);
	plaintext.writeUInt16BE(tunnel.length, 2);
	plaintext.writeUInt32BE(sequence, 4);
	client.copy(plaintext, 8);
	tunnel.copy(plaintext, 8 + client.length);
	data.copy(plaintext, 8 + client.length + tunnel.length);

	const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
	const ciphertext = sodium.crypto_secretbox_easy(
		plaintext,
		nonce,
		encryptionKey,
	);
	const frame = Buffer.alloc(31 + client.length + ciphertext.length);
	frame.write("SHPB", 0);
	frame.writeUInt8(1, 4);
	frame.writeUInt8(2, 5);
	frame.writeUInt8(client.length, 6);
	Buffer.from(nonce).copy(frame, 7);
	client.copy(frame, 31);
	Buffer.from(ciphertext).copy(frame, 31 + client.length);
	return frame;
}

function decodeTunnelFrame(frame: Buffer): {
	tunnelId: string;
	sequence: number;
	data: Buffer;
} {
	const clientLength = frame.readUInt8(6);
	const nonce = frame.subarray(7, 31);
	const plaintext = Buffer.from(
		sodium.crypto_secretbox_open_easy(
			frame.subarray(31 + clientLength),
			nonce,
			encryptionKey,
		),
	);
	const payloadClientLength = plaintext.readUInt8(1);
	const tunnelLength = plaintext.readUInt16BE(2);
	const tunnelStart = 8 + payloadClientLength;
	const dataStart = tunnelStart + tunnelLength;
	return {
		tunnelId: plaintext.toString("utf8", tunnelStart, dataStart),
		sequence: plaintext.readUInt32BE(4),
		data: plaintext.subarray(dataStart),
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000) {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) {
			throw new Error("Timed out waiting for tunnel state");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

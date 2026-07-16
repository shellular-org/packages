import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { MsgType } from "@shellular/protocol";
import sodium from "libsodium-wrappers";
import WebSocket from "ws";

const originalHome = process.env.HOME;
const testHome = fs.mkdtempSync(
	path.join(os.tmpdir(), "shellular-local-test-"),
);
process.env.HOME = testHome;

let server: import("./local-server").LocalControlServer;
let agents: import("./agents").AgentsManager;
let hub: import("./connection-hub").ConnectionHub;
let token: string;

before(async () => {
	const [
		configModule,
		encryptionModule,
		hubModule,
		serverModule,
		fsModule,
		terminalModule,
		agentsModule,
	] = await Promise.all([
		import("./config"),
		import("./encryption"),
		import("./connection-hub"),
		import("./local-server"),
		import("./filesystem"),
		import("./terminal"),
		import("./agents"),
	]);
	configModule.ensureConfig();
	await encryptionModule.initEncryption();
	await sodium.ready;

	hub = new hubModule.ConnectionHub();
	const connection = hub.asHostConnection();
	fsModule.initFilesystemHandler(connection, testHome);
	terminalModule.initTerminalHandler(connection, testHome);
	agents = new agentsModule.AgentsManager();
	agents.handleConnection(connection);
	token = "local-test-token-0123456789abcdef";
	server = new serverModule.LocalControlServer({
		port: 0,
		token,
		hostInfo: {
			id: "host_local_test",
			hostname: "Test Mac",
			username: "tester",
			platform: "darwin",
			dir: testHome,
			machineId: "machine-local-test",
			cliVersion: "test",
		},
		hub,
		source: "development",
		lifecycle: "attached",
		getRemoteState: () => "disconnected",
		onStop: () => undefined,
		onDisable: () => undefined,
	});
	await server.start();
});

after(() => {
	server?.close();
	agents?.destroy();
	hub?.close();
	process.env.HOME = originalHome;
	fs.rmSync(testHome, { force: true, recursive: true });
});

test("local encrypted requests reach filesystem, terminal, and agent handlers", async () => {
	const clientId = "c_local-test";
	const ticket = await createTicket(clientId);
	const ws = await connect(ticket.wsUrl, ticket.ticket);
	const key = sodium.from_base64(
		ticket.encryptionKey,
		sodium.base64_variants.ORIGINAL,
	);

	try {
		const requests = [
			{ type: MsgType.FS_LIST, data: { path: "." } },
			{ type: MsgType.TERMINAL_LIST },
			{ type: MsgType.AI_AGENTS_LIST, data: {} },
			{ type: MsgType.AI_ACTIVITY_LIST, data: {} },
		] as const;

		for (const [index, request] of requests.entries()) {
			const id = `request-${index}`;
			const response = await sendEncryptedRequest(ws, key, {
				id,
				clientId,
				...request,
			});
			assert.equal(response.respTo, id);
			assert.equal(response.error, undefined);
		}
	} finally {
		ws.close();
	}
});

test("missing outer identity is normalized from the ticket", async () => {
	const clientId = "c_compat-test";
	const ticket = await createTicket(clientId);
	const ws = await connect(ticket.wsUrl, ticket.ticket);
	const key = sodium.from_base64(
		ticket.encryptionKey,
		sodium.base64_variants.ORIGINAL,
	);
	try {
		const response = await sendEncryptedRequest(
			ws,
			key,
			{
				id: "compat-request",
				type: MsgType.TERMINAL_LIST,
				clientId,
			},
			false,
		);
		assert.equal(response.respTo, "compat-request");
	} finally {
		ws.close();
	}
});

test("a mismatched outer identity closes the socket", async () => {
	const clientId = "c_identity-test";
	const ticket = await createTicket(clientId);
	const ws = await connect(ticket.wsUrl, ticket.ticket);
	const key = sodium.from_base64(
		ticket.encryptionKey,
		sodium.base64_variants.ORIGINAL,
	);
	const close = new Promise<{ code: number; reason: string }>((resolve) => {
		ws.once("close", (code, reason) =>
			resolve({ code, reason: reason.toString() }),
		);
	});
	sendEncrypted(
		ws,
		key,
		{
			id: "spoofed-request",
			type: MsgType.TERMINAL_LIST,
			clientId,
		},
		true,
		"c_someone-else",
	);
	assert.deepEqual(await close, {
		code: 1008,
		reason: "Local client identity mismatch",
	});
});

type Ticket = {
	wsUrl: string;
	ticket: string;
	encryptionKey: string;
};

async function createTicket(clientId: string): Promise<Ticket> {
	const response = await fetch(
		`http://127.0.0.1:${server.listeningPort}/control/ticket`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				protocolVersion: 1,
				client: {
					clientId,
					appVersion: "test",
					platform: "macos",
					deviceModel: "Test Mac",
					deviceIsEmulator: false,
					deviceManufacturer: "Test",
				},
			}),
		},
	);
	assert.equal(response.status, 200);
	return (await response.json()) as Ticket;
}

async function connect(wsUrl: string, ticket: string): Promise<WebSocket> {
	const url = new URL(wsUrl);
	url.searchParams.set("ticket", ticket);
	const ws = new WebSocket(url);
	await new Promise<void>((resolve, reject) => {
		ws.once("message", () => resolve());
		ws.once("error", reject);
	});
	return ws;
}

type Request = {
	id: string;
	type: string;
	clientId: string;
	data?: unknown;
};

function sendEncrypted(
	ws: WebSocket,
	key: Uint8Array,
	request: Request,
	includeOuterClientId = true,
	outerClientId = request.clientId,
): void {
	const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
	const ciphertext = sodium.crypto_secretbox_easy(
		JSON.stringify(request),
		nonce,
		key,
	);
	ws.send(
		JSON.stringify({
			id: request.id,
			type: MsgType.ENCRYPTED,
			...(includeOuterClientId ? { clientId: outerClientId } : {}),
			nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
			ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL),
		}),
	);
}

async function sendEncryptedRequest(
	ws: WebSocket,
	key: Uint8Array,
	request: Request,
	includeOuterClientId = true,
): Promise<Record<string, unknown>> {
	const response = new Promise<Record<string, unknown>>((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error(`Timed out waiting for ${request.type}`)),
			2_000,
		);
		const onMessage = (raw: WebSocket.RawData) => {
			const envelope = JSON.parse(raw.toString()) as Record<string, unknown>;
			if (envelope.type !== MsgType.ENCRYPTED) return;
			const plaintext = sodium.crypto_secretbox_open_easy(
				sodium.from_base64(
					envelope.ciphertext as string,
					sodium.base64_variants.ORIGINAL,
				),
				sodium.from_base64(
					envelope.nonce as string,
					sodium.base64_variants.ORIGINAL,
				),
				key,
			);
			const message = JSON.parse(sodium.to_string(plaintext)) as Record<
				string,
				unknown
			>;
			if (message.respTo !== request.id) return;
			clearTimeout(timeout);
			ws.off("message", onMessage);
			resolve(message);
		};
		ws.on("message", onMessage);
	});
	sendEncrypted(ws, key, request, includeOuterClientId);
	return response;
}

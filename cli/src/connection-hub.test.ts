import assert from "node:assert/strict";
import { test } from "node:test";

import { MsgType } from "@shellular/protocol";

import { ConnectionHub, type HubTransport } from "./connection-hub";

function transport(
	id: string,
	kind: HubTransport["kind"],
	messages: unknown[],
): HubTransport {
	return {
		id,
		kind,
		send: (message) => messages.push(message),
		sendBinary: () => true,
		isOpen: () => true,
		getBufferedAmount: () => 0,
		close: () => undefined,
	};
}

test("a stale remote leave cannot remove a newer local client route", () => {
	const hub = new ConnectionHub();
	const remoteMessages: unknown[] = [];
	const localMessages: unknown[] = [];
	const client = {
		clientId: "c_shared-client",
		hostId: "host_test",
		appVersion: "test",
		platform: "macos" as const,
		deviceModel: "Test Mac",
		deviceIsEmulator: false,
		deviceManufacturer: "Test",
	};

	hub.registerTransport(transport("remote", "remote", remoteMessages));
	hub.acceptIncoming("remote", {
		type: MsgType.SESSION_CLIENT_JOINED,
		data: client,
	});
	hub.registerTransport(transport("local", "local", localMessages));
	hub.acceptIncoming("local", {
		type: MsgType.SESSION_CLIENT_JOINED,
		data: client,
	});

	assert.equal(
		hub.acceptIncoming("remote", {
			type: MsgType.SESSION_CLIENT_LEFT,
			data: { clientId: client.clientId },
		}),
		false,
	);
	hub.send({
		type: MsgType.TERMINAL_LIST_RESULT,
		clientId: client.clientId,
		respTo: "request-1",
		data: { terminals: [] },
	});

	assert.equal(remoteMessages.length, 0);
	assert.equal(localMessages.length, 1);
});

import { EventEmitter } from "node:events";

import {
	type HostIncomingMsg,
	MsgType,
	type SessionClientLeftMsg,
} from "@shellular/protocol";

import { ConnectedClients } from "@/clients/connected";
import type { Connection, HostConnection, SendableMsg } from "@/connection";

export interface HubTransport {
	id: string;
	kind: "remote" | "local";
	send(msg: SendableMsg): void;
	sendBinary(data: Uint8Array | Buffer): boolean;
	isOpen(): boolean;
	getBufferedAmount(): number;
	close(): void;
}

export class ConnectionHub extends EventEmitter {
	readonly clients = new ConnectedClients();
	private readonly transports = new Map<string, HubTransport>();
	private readonly clientTransports = new Map<string, string>();

	asHostConnection(): HostConnection {
		return this as unknown as HostConnection;
	}

	attachRemote(connection: Connection): void {
		const transport: HubTransport = {
			id: "remote",
			kind: "remote",
			send: (msg) => connection.send(msg as never),
			sendBinary: (data) => connection.sendBinary(data),
			isOpen: () => connection.isOpen(),
			getBufferedAmount: () => connection.getBufferedAmount(),
			close: () => connection.close(),
		};
		this.registerTransport(transport);
		connection.setIncomingSink((msg) => this.acceptIncoming(transport.id, msg));
		connection.once("disconnected", () => this.detachTransport(transport.id));
	}

	registerTransport(transport: HubTransport): void {
		const existing = this.transports.get(transport.id);
		if (existing && existing !== transport) existing.close();
		this.transports.set(transport.id, transport);
	}

	detachTransport(transportId: string): void {
		this.transports.delete(transportId);
		for (const [clientId, owner] of [...this.clientTransports]) {
			if (owner !== transportId) continue;
			this.clientTransports.delete(clientId);
			this.clients.delete(clientId);
			const left: SessionClientLeftMsg = {
				type: MsgType.SESSION_CLIENT_LEFT,
				data: { clientId },
			};
			super.emit(MsgType.SESSION_CLIENT_LEFT, left);
		}
	}

	acceptIncoming(transportId: string, msg: HostIncomingMsg): boolean {
		if (
			msg.type === MsgType.SESSION_CLIENT_JOIN ||
			msg.type === MsgType.SESSION_CLIENT_JOINED
		) {
			this.clientTransports.set(msg.data.clientId, transportId);
		}

		if (msg.type === MsgType.SESSION_CLIENT_JOINED) {
			this.clients.add(msg.data.clientId, msg.data);
		} else if (msg.type === MsgType.SESSION_CLIENT_LEFT) {
			if (this.clientTransports.get(msg.data.clientId) !== transportId)
				return false;
			this.clients.delete(msg.data.clientId);
			this.clientTransports.delete(msg.data.clientId);
		} else if ("clientId" in msg && typeof msg.clientId === "string") {
			this.clientTransports.set(msg.clientId, transportId);
		}

		return super.emit(msg.type, msg);
	}

	send<TType extends SendableMsg["type"]>(
		msg: Extract<SendableMsg, { type: TType }>,
	): void {
		const clientId = getMessageClientId(msg);
		if (clientId) {
			const transport = this.transportForClient(clientId);
			if (transport?.isOpen()) transport.send(msg as SendableMsg);
			return;
		}

		for (const transport of this.transports.values()) {
			if (transport.isOpen()) transport.send(msg as SendableMsg);
		}
	}

	sendBinary(data: Uint8Array | Buffer, clientId?: string): boolean {
		if (!clientId) return false;
		const transport = this.transportForClient(clientId);
		return transport?.isOpen() ? transport.sendBinary(data) : false;
	}

	isOpen(clientId?: string): boolean {
		if (clientId) return this.transportForClient(clientId)?.isOpen() ?? false;
		return [...this.transports.values()].some((transport) =>
			transport.isOpen(),
		);
	}

	getBufferedAmount(clientId?: string): number {
		if (clientId) {
			return this.transportForClient(clientId)?.getBufferedAmount() ?? 0;
		}
		return Math.max(
			0,
			...[...this.transports.values()].map((transport) =>
				transport.getBufferedAmount(),
			),
		);
	}

	close(): void {
		for (const transport of this.transports.values()) transport.close();
		this.transports.clear();
		this.clientTransports.clear();
		this.clients.removeAll();
		super.emit("disconnected", { code: 1000, reason: "CLI stopped" });
	}

	private transportForClient(clientId: string): HubTransport | undefined {
		const transportId = this.clientTransports.get(clientId);
		return transportId ? this.transports.get(transportId) : undefined;
	}
}

function getMessageClientId(msg: SendableMsg): string | undefined {
	if ("clientId" in msg && typeof msg.clientId === "string")
		return msg.clientId;
	if (
		msg.type === MsgType.SESSION_CLIENT_JOIN_RESULT &&
		"data" in msg &&
		msg.data &&
		typeof msg.data === "object" &&
		"clientId" in msg.data &&
		typeof msg.data.clientId === "string"
	) {
		return msg.data.clientId;
	}
	return undefined;
}

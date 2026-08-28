import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import {
	ClientToHostMsgSchema,
	type HostInfo,
	LOCAL_CONTROL_PROTOCOL_VERSION,
	LocalCliClientMutationSchema,
	type LocalCliSnapshot,
	LocalCliTicketRequestSchema,
	MsgType,
} from "@shellular/protocol";
import { nanoid } from "nanoid";
import WebSocket, { WebSocketServer } from "ws";

import {
	deleteKnownClient,
	readKnownClients,
	setKnownClientApproval,
} from "@/clients";
import { config } from "@/config";
import {
	decodeHostIncoming,
	encodeHostOutgoing,
	type SendableMsg,
} from "@/connection";
import type { ConnectionHub, HubTransport } from "@/connection-hub";
import { getKeyBase64 } from "@/encryption";
import { logger } from "@/logger";

type Ticket = {
	client: ReturnType<typeof LocalCliTicketRequestSchema.parse>["client"];
	expiresAt: number;
};

export type LocalServerOptions = {
	port: number;
	token: string;
	hostInfo: HostInfo;
	hub: ConnectionHub;
	source: "development" | "npx" | "global" | "attached" | "manual";
	lifecycle: "app-owned" | "attached";
	getRemoteState: () => LocalCliSnapshot["remoteState"];
	onStop: () => void;
	onDisable: () => void;
};

export class LocalControlServer {
	private readonly tickets = new Map<string, Ticket>();
	private readonly instanceId = nanoid();
	private readonly startedAt = new Date();
	private server: http.Server | null = null;
	private wsServer: WebSocketServer | null = null;
	private port = 0;
	private token: string;
	private source: LocalServerOptions["source"];
	private lifecycle: LocalServerOptions["lifecycle"];

	constructor(private readonly options: LocalServerOptions) {
		this.token = options.token;
		this.source = options.source;
		this.lifecycle = options.lifecycle;
	}

	get listeningPort(): number {
		return this.port;
	}

	reconfigure({
		token,
		source,
	}: {
		token: string;
		source: LocalServerOptions["source"];
	}): void {
		if (token !== this.token) {
			this.token = token;
			this.tickets.clear();
			this.wsServer?.clients.forEach((client) => {
				client.close(4001, "Local app authorization changed");
			});
		}
		this.source = source;
	}

	async start(): Promise<number> {
		const wsServer = new WebSocketServer({ noServer: true });
		this.wsServer = wsServer;
		const server = http.createServer(
			(req, res) => void this.handleHttp(req, res),
		);
		this.server = server;
		server.on("upgrade", (req, socket, head) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			const ticketValue = url.searchParams.get("ticket");
			const ticket = ticketValue ? this.tickets.get(ticketValue) : undefined;
			if (url.pathname !== "/app" || !ticket || ticket.expiresAt < Date.now()) {
				socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
				socket.destroy();
				return;
			}
			if (!ticketValue) return;
			this.tickets.delete(ticketValue);
			wsServer.handleUpgrade(req, socket, head, (ws) =>
				this.acceptClient(ws, ticket),
			);
		});

		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.options.port, "127.0.0.1", () => resolve());
		});
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("Local listener did not expose a TCP port");
		this.port = address.port;
		this.writeDiscovery();
		logger.log(`Local desktop listener ready on 127.0.0.1:${this.port}`);
		return this.port;
	}

	close(): void {
		this.wsServer?.clients.forEach((client) => {
			client.close(1001, "CLI stopping");
		});
		try {
			this.wsServer?.close();
		} catch {}
		try {
			this.server?.close();
		} catch {}
		try {
			const discovery = JSON.parse(
				fs.readFileSync(this.discoveryPath(), "utf8"),
			) as { instanceId?: string };
			if (discovery.instanceId === this.instanceId)
				fs.rmSync(this.discoveryPath(), { force: true });
		} catch {}
	}

	private async handleHttp(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("Content-Type", "application/json");
		if (!this.authorized(req))
			return this.json(res, 401, {
				error: {
					code: "AUTHENTICATION_FAILED",
					message: "Invalid local control token",
				},
			});
		try {
			if (req.method === "GET" && req.url === "/control/status")
				return this.json(res, 200, this.snapshot());
			if (req.method === "POST" && req.url === "/control/ticket") {
				const request = LocalCliTicketRequestSchema.parse(
					await this.readJson(req),
				);
				const ticket = nanoid(32);
				this.tickets.set(ticket, {
					client: request.client,
					expiresAt: Date.now() + 10_000,
				});
				return this.json(res, 200, {
					wsUrl: `ws://127.0.0.1:${this.port}/app`,
					ticket,
					hostId: this.options.hostInfo.id,
					clientId: request.client.clientId,
					encryptionKey: getKeyBase64(),
					protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
				});
			}
			if (req.method === "POST" && req.url === "/control/clients") {
				const mutation = LocalCliClientMutationSchema.parse(
					await this.readJson(req),
				);
				const changed =
					mutation.action === "delete"
						? deleteKnownClient(mutation.clientId)
						: setKnownClientApproval(mutation.clientId, mutation.approved);
				return this.json(res, changed ? 200 : 404, { success: changed });
			}
			if (req.method === "POST" && req.url === "/control/stop") {
				if (this.lifecycle !== "app-owned")
					return this.json(res, 409, {
						error: {
							code: "PROCESS_NOT_OWNED",
							message:
								"This CLI was already running; disable local access instead.",
						},
					});
				this.json(res, 202, { success: true });
				setImmediate(this.options.onStop);
				return;
			}
			if (req.method === "POST" && req.url === "/control/disable") {
				this.json(res, 202, { success: true });
				setImmediate(this.options.onDisable);
				return;
			}
			this.json(res, 404, {
				error: { code: "NOT_FOUND", message: "Unknown local control route" },
			});
		} catch (error) {
			this.json(res, 400, {
				error: {
					code: "INVALID_REQUEST",
					message: error instanceof Error ? error.message : String(error),
				},
			});
		}
	}

	private acceptClient(ws: WebSocket, ticket: Ticket): void {
		const client = { ...ticket.client, hostId: this.options.hostInfo.id };
		const transportId = `local:${client.clientId}:${nanoid(6)}`;
		const transport: HubTransport = {
			id: transportId,
			kind: "local",
			send: (msg: SendableMsg) => {
				if (ws.readyState === WebSocket.OPEN) ws.send(encodeHostOutgoing(msg));
			},
			sendBinary: (data) => {
				if (ws.readyState !== WebSocket.OPEN) return false;
				ws.send(data, { binary: true });
				return true;
			},
			isOpen: () => ws.readyState === WebSocket.OPEN,
			getBufferedAmount: () => ws.bufferedAmount,
			close: () => ws.close(),
		};
		this.options.hub.registerTransport(transport);
		ws.send(
			JSON.stringify({
				type: MsgType.SESSION_JOINED,
				data: { ...this.options.hostInfo, sessionId: transportId },
			}),
		);
		this.options.hub.acceptIncoming(transportId, {
			type: MsgType.SESSION_CLIENT_JOINED,
			data: client,
		});
		ws.on("message", (data, isBinary) => {
			if (isBinary) return;
			const raw = data.toString();
			let outer: Record<string, unknown>;
			try {
				const parsed = JSON.parse(raw);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
					throw new Error("Message must be an object");
				outer = parsed as Record<string, unknown>;
				if (outer.type === MsgType.PING) {
					ws.send(
						JSON.stringify({ id: `host_${nanoid()}`, type: MsgType.PONG }),
					);
					return;
				}
			} catch {
				logger.warn("Rejected invalid local client frame");
				ws.close(1008, "Invalid local client frame");
				return;
			}
			if (
				outer.type === MsgType.ENCRYPTED &&
				outer.clientId !== undefined &&
				outer.clientId !== client.clientId
			) {
				logger.warn("Rejected local client frame with mismatched identity");
				ws.close(1008, "Local client identity mismatch");
				return;
			}
			const normalized =
				outer.type === MsgType.ENCRYPTED
					? JSON.stringify({ ...outer, clientId: client.clientId })
					: raw;
			const message = decodeHostIncoming(normalized);
			const clientMessage = ClientToHostMsgSchema.safeParse(message);
			if (
				!clientMessage.success ||
				("clientId" in clientMessage.data &&
					clientMessage.data.clientId !== client.clientId)
			) {
				logger.warn("Rejected invalid local client message");
				ws.close(1008, "Invalid local client message");
				return;
			}
			this.options.hub.acceptIncoming(transportId, clientMessage.data);
		});
		ws.once("close", () => this.options.hub.detachTransport(transportId));
	}

	private snapshot(): LocalCliSnapshot {
		const connected = new Set(this.options.hub.clients.getAll());
		return {
			state: "running",
			cliVersion: config.VERSION,
			protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
			pid: process.pid,
			port: this.port,
			uptimeMs: Date.now() - this.startedAt.getTime(),
			directory: this.options.hostInfo.dir,
			machineName: config.HOSTNAME,
			source: this.source,
			lifecycle: this.lifecycle,
			remoteState: this.options.getRemoteState(),
			hostInfo: this.options.hostInfo,
			qrData: `${this.options.hostInfo.id}:${getKeyBase64()}`,
			clients: Object.values(readKnownClients()).map(
				({ hostId: _hostId, ...client }) => ({
					...client,
					connected: connected.has(client.clientId),
				}),
			),
			logs: logger.getEntries(),
		};
	}

	private authorized(req: IncomingMessage): boolean {
		const supplied =
			req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
		const expected = this.token;
		const a = Buffer.from(supplied);
		const b = Buffer.from(expected);
		return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
	}

	private readJson(req: IncomingMessage): Promise<unknown> {
		return new Promise((resolve, reject) => {
			let body = "";
			req.setEncoding("utf8");
			req.on("data", (chunk) => {
				body += chunk;
				if (body.length > 64_000) reject(new Error("Request too large"));
			});
			req.on("end", () => {
				try {
					resolve(body ? JSON.parse(body) : {});
				} catch (error) {
					reject(error);
				}
			});
			req.on("error", reject);
		});
	}

	private json(res: ServerResponse, status: number, body: unknown): void {
		res.statusCode = status;
		res.end(JSON.stringify(body));
	}
	private discoveryPath(): string {
		return path.join(config.SHELLULAR_DIR, "local-control.json");
	}
	private writeDiscovery(): void {
		const target = this.discoveryPath();
		const temp = `${target}.${process.pid}.tmp`;
		fs.writeFileSync(
			temp,
			JSON.stringify({
				pid: process.pid,
				port: this.port,
				instanceId: this.instanceId,
				cliVersion: config.VERSION,
				protocolVersion: LOCAL_CONTROL_PROTOCOL_VERSION,
				startedAt: this.startedAt.toISOString(),
				source: this.source,
				lifecycle: this.lifecycle,
			}),
			{ mode: 0o600 },
		);
		fs.renameSync(temp, target);
		fs.chmodSync(target, 0o600);
	}
}

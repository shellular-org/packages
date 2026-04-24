import type http from "node:http";
import { request as httpRequest } from "node:http";
import { MsgType } from "@shellular/protocol";
import WebSocket from "ws";
import type { Connection } from "./connection";

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
const CHUNK_SIZE = 256 * 1024; // 256KB per chunk

// Active HTTP requests (requestId → ClientRequest) for abort-on-disconnect
const activeRequests = new Map<string, http.ClientRequest>();

// Active WebSocket connections (wsId → WebSocket) for cleanup
const activeWebSockets = new Map<string, WebSocket>();

let wsCounter = 0;

function isLocalhostUrl(urlStr: string, allowedSchemes: string[]): URL | null {
	let url: URL;
	try {
		url = new URL(urlStr);
	} catch {
		return null;
	}

	if (!allowedSchemes.includes(url.protocol)) return null;

	// url.hostname strips brackets from IPv6, e.g. [::1] → ::1
	if (!ALLOWED_HOSTS.has(url.hostname)) return null;

	const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
	if (port < 1 || port > 65535) return null;

	return url;
}

export function initProxyHandler(conn: Connection) {
	// ─── HTTP tunneling ───────────────────────────────────────

	conn.on(MsgType.HTTP_REQUEST, (msg) => {
		const requestId = msg.id;
		if (!requestId) {
			return;
		}
		const { clientId } = msg;
		const { method, url: urlStr, headers, body, bodyEncoding } = msg.data;

		const url = isLocalhostUrl(urlStr, ["http:", "https:"]);
		if (!url) {
			conn.send({
				type: MsgType.HTTP_RESPONSE_END,
				clientId,
				error: "Only localhost URLs (http) are allowed",
				data: {
					requestId,
				},
			});
			return;
		}

		const reqOptions: http.RequestOptions = {
			hostname: url.hostname,
			port: url.port || 80,
			path: url.pathname + url.search,
			method: method.toUpperCase(),
			headers: headers,
		};

		const req = httpRequest(reqOptions, (res) => {
			// Send response headers
			const responseHeaders: Record<string, string | string[]> = {};
			for (const [key, value] of Object.entries(res.headers)) {
				if (value !== undefined) {
					responseHeaders[key] = value;
				}
			}

			conn.send({
				type: MsgType.HTTP_RESPONSE_START,
				clientId,
				respTo: requestId,
				data: {
					requestId,
					status: res.statusCode ?? 0,
					statusText: res.statusMessage ?? "",
					headers: responseHeaders,
				},
			});

			// Stream response body in chunks
			let chunkIndex = 0;

			res.on("data", (chunk: Buffer) => {
				const base64 = chunk.toString("base64");

				// Split into CHUNK_SIZE segments if needed
				for (let i = 0; i < base64.length; i += CHUNK_SIZE) {
					conn.send({
						type: MsgType.HTTP_RESPONSE_DATA,
						clientId,
						data: {
							requestId,
							chunk: base64.slice(i, i + CHUNK_SIZE),
							index: chunkIndex++,
						},
					});
				}
			});

			res.on("end", () => {
				activeRequests.delete(requestId);
				conn.send({
					type: MsgType.HTTP_RESPONSE_END,
					clientId,
					data: { requestId },
				});
			});

			res.on("error", (err) => {
				activeRequests.delete(requestId);
				conn.send({
					type: MsgType.HTTP_RESPONSE_END,
					clientId,
					error: err.message,
					data: { requestId },
				});
			});
		});

		req.on("error", (err) => {
			activeRequests.delete(requestId);
			conn.send({
				type: MsgType.HTTP_RESPONSE_END,
				clientId,
				error: err.message,
				data: { requestId },
			});
		});

		activeRequests.set(requestId, req);

		// Write request body if present
		if (body) {
			const encoding = bodyEncoding === "base64" ? "base64" : "utf-8";
			req.write(Buffer.from(body, encoding));
		}

		req.end();
	});

	// ─── WebSocket tunneling ──────────────────────────────────

	conn.on(MsgType.WS_OPEN, (msg) => {
		const requestId = msg.id;
		const { clientId } = msg;
		const { url: urlStr, protocols, headers } = msg.data;

		const url = isLocalhostUrl(urlStr, ["ws:", "wss:"]);
		if (!url) {
			conn.send({
				type: MsgType.WS_OPENED,
				clientId,
				respTo: requestId,
				error: "Only localhost URLs (ws) are allowed",
			});
			return;
		}

		const wsId = `ws-${++wsCounter}`;

		const ws = new WebSocket(urlStr, protocols ?? [], {
			headers,
		});

		ws.on("open", () => {
			activeWebSockets.set(wsId, ws);
			conn.send({
				type: MsgType.WS_OPENED,
				clientId,
				respTo: requestId,
				data: { wsId, protocol: ws.protocol || undefined },
			});
		});

		ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
			if (isBinary) {
				const buf = Buffer.isBuffer(data)
					? data
					: Buffer.from(data as ArrayBuffer);
				conn.send({
					type: MsgType.WS_DATA,
					clientId,
					data: { wsId, data: buf.toString("base64"), encoding: "base64" },
				});
			} else {
				conn.send({
					type: MsgType.WS_DATA,
					clientId,
					data: { wsId, data: data.toString(), encoding: "utf-8" },
				});
			}
		});

		ws.on("close", (code, reason) => {
			activeWebSockets.delete(wsId);
			conn.send({
				type: MsgType.WS_CLOSED,
				clientId,
				data: {
					wsId,
					code,
					reason: reason?.toString(),
				},
			});
		});

		ws.on("error", (err) => {
			// If not yet in activeWebSockets, the open failed
			if (!activeWebSockets.has(wsId)) {
				conn.send({
					type: MsgType.WS_OPENED,
					clientId,
					respTo: requestId,
					error: err.message,
				});
			}
			// The 'close' event will follow and handle cleanup
		});
	});

	conn.on(MsgType.WS_DATA, (msg) => {
		const { wsId, data, encoding } = msg.data;
		const ws = activeWebSockets.get(wsId);
		if (!ws) return;

		if (encoding === "base64") {
			ws.send(Buffer.from(data, "base64"));
		} else {
			ws.send(data);
		}
	});

	conn.on(MsgType.WS_CLOSE, (msg) => {
		const { wsId, code, reason } = msg.data;
		const ws = activeWebSockets.get(wsId);
		if (!ws) return;

		ws.close(code ?? 1000, reason);
	});
}

export function cleanupProxy() {
	// Abort all in-flight HTTP requests
	for (const [id, req] of activeRequests) {
		req.destroy();
		activeRequests.delete(id);
	}

	// Close all tunneled WebSocket connections
	for (const [id, ws] of activeWebSockets) {
		ws.close(1001, "Host disconnected");
		activeWebSockets.delete(id);
	}
}

import type http from "node:http";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { MsgType } from "@shellular/protocol";
import WebSocket from "ws";
import type { Connection } from "./connection";
import { encryptBytes } from "./encryption";

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
const PROXY_BINARY_MAGIC = Buffer.from("SHPB");
const PROXY_BINARY_VERSION = 1;
const PROXY_BINARY_KIND_HTTP_RESPONSE_DATA = 1;
const PROXY_BINARY_HEADER_BYTES = 4 + 1 + 1 + 1 + 24;
const INITIAL_HTTP_RESPONSE_CHUNK_BYTES = 64 * 1024;
const STEADY_STATE_HTTP_RESPONSE_CHUNK_BYTES = 256 * 1024;
const INITIAL_RESPONSE_WINDOW_BYTES = 192 * 1024;
const MAX_REDIRECTS = 20;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const HOP_BY_HOP_HEADERS = new Set([
	"connection",
	"host",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);
const WS_BACKPRESSURE_HIGH_WATER = 8 * 1024 * 1024;
const WS_BACKPRESSURE_LOW_WATER = 2 * 1024 * 1024;
const WS_BACKPRESSURE_POLL_MS = 10;
const backpressuredResponses = new WeakSet<http.IncomingMessage>();

const httpAgent = new HttpAgent({
	keepAlive: true,
	maxFreeSockets: 32,
	maxSockets: 128,
	timeout: 30_000,
});

const httpsAgent = new HttpsAgent({
	keepAlive: true,
	maxFreeSockets: 32,
	maxSockets: 128,
	timeout: 30_000,
});

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

function toBuffer(data: WebSocket.RawData): Buffer {
	if (Buffer.isBuffer(data)) {
		return data;
	}

	if (Array.isArray(data)) {
		return Buffer.concat(data);
	}

	return Buffer.from(data);
}

function getHeader(
	headers: http.IncomingHttpHeaders,
	name: string,
): string | undefined {
	const value = headers[name.toLowerCase()];
	if (Array.isArray(value)) {
		return value[0];
	}

	return value;
}

function makeHostHeader(url: URL): string {
	const defaultPort = url.protocol === "https:" ? "443" : "80";
	return url.port && url.port !== defaultPort
		? `${url.hostname}:${url.port}`
		: url.hostname;
}

function buildRequestHeaders(
	headers: Record<string, string> | undefined,
	url: URL,
	hasBody: boolean,
	cookies: Map<string, string>,
): Record<string, string> {
	const nextHeaders: Record<string, string> = {};

	for (const [key, value] of Object.entries(headers ?? {})) {
		const lowerKey = key.toLowerCase();
		if (
			HOP_BY_HOP_HEADERS.has(lowerKey) ||
			(!hasBody &&
				(lowerKey === "content-length" || lowerKey === "content-type"))
		) {
			continue;
		}

		nextHeaders[key] = value;
	}

	nextHeaders.host = makeHostHeader(url);

	if (cookies.size > 0) {
		let cookieHeaderKey = "";
		for (const key of Object.keys(nextHeaders)) {
			if (key.toLowerCase() === "cookie") {
				cookieHeaderKey = key;
				break;
			}
		}

		let redirectCookie = "";
		for (const [name, value] of cookies) {
			redirectCookie += redirectCookie
				? `; ${name}=${value}`
				: `${name}=${value}`;
		}

		if (cookieHeaderKey) {
			nextHeaders[cookieHeaderKey] =
				`${nextHeaders[cookieHeaderKey]}; ${redirectCookie}`;
		} else {
			nextHeaders.cookie = redirectCookie;
		}
	}

	return nextHeaders;
}

function rememberSetCookies(
	cookies: Map<string, string>,
	setCookie: string[] | undefined,
) {
	for (const cookie of setCookie ?? []) {
		const pairEnd = cookie.indexOf(";");
		const pair = pairEnd === -1 ? cookie : cookie.slice(0, pairEnd);
		const separatorIndex = pair.indexOf("=");
		if (separatorIndex <= 0) continue;

		cookies.set(pair.slice(0, separatorIndex), pair.slice(separatorIndex + 1));
	}
}

function shouldRedirect(res: http.IncomingMessage) {
	return REDIRECT_STATUS_CODES.has(res.statusCode ?? 0);
}

function resolveRedirectUrl(location: string | undefined, currentUrl: URL) {
	if (!location) return null;

	try {
		return isLocalhostUrl(new URL(location, currentUrl).toString(), [
			"http:",
			"https:",
		]);
	} catch {
		return null;
	}
}

function nextRedirectMethod(
	statusCode: number,
	method: string,
): { method: string; keepBody: boolean } {
	const upperMethod = method.toUpperCase();
	if (statusCode === 303 && upperMethod !== "HEAD") {
		return { method: "GET", keepBody: false };
	}

	if ((statusCode === 301 || statusCode === 302) && upperMethod === "POST") {
		return { method: "GET", keepBody: false };
	}

	return { method: upperMethod, keepBody: true };
}

function drainResponse(res: http.IncomingMessage, onDone: () => void) {
	res.resume();
	res.once("end", onDone);
}

function maybePauseForBackpressure(
	conn: Connection,
	res: http.IncomingMessage,
) {
	if (
		conn.ws.bufferedAmount < WS_BACKPRESSURE_HIGH_WATER ||
		backpressuredResponses.has(res)
	) {
		return;
	}

	backpressuredResponses.add(res);
	res.pause();

	const resumeWhenReady = () => {
		if (res.destroyed) {
			backpressuredResponses.delete(res);
			return;
		}

		if (conn.ws.readyState !== WebSocket.OPEN) {
			backpressuredResponses.delete(res);
			res.destroy(new Error("Proxy WebSocket closed"));
			return;
		}

		if (conn.ws.bufferedAmount <= WS_BACKPRESSURE_LOW_WATER) {
			backpressuredResponses.delete(res);
			res.resume();
			return;
		}

		setTimeout(resumeWhenReady, WS_BACKPRESSURE_POLL_MS);
	};

	setTimeout(resumeWhenReady, WS_BACKPRESSURE_POLL_MS);
}

function buildHttpResponseDataPlaintext(
	clientId: string,
	requestId: string,
	chunkIndex: number,
	chunk: Buffer,
): Buffer {
	const clientIdBytes = Buffer.from(clientId);
	const requestIdBytes = Buffer.from(requestId);
	if (clientIdBytes.length > 255) {
		throw new Error("Client id is too large for proxy binary frame");
	}
	if (requestIdBytes.length > 65_535) {
		throw new Error("Request id is too large for proxy binary frame");
	}

	const headerLength = 1 + 1 + 2 + 4;
	const plaintext = Buffer.allocUnsafe(
		headerLength + clientIdBytes.length + requestIdBytes.length + chunk.length,
	);
	plaintext.writeUInt8(PROXY_BINARY_KIND_HTTP_RESPONSE_DATA, 0);
	plaintext.writeUInt8(clientIdBytes.length, 1);
	plaintext.writeUInt16BE(requestIdBytes.length, 2);
	plaintext.writeUInt32BE(chunkIndex, 4);
	clientIdBytes.copy(plaintext, headerLength);
	requestIdBytes.copy(plaintext, headerLength + clientIdBytes.length);
	chunk.copy(
		plaintext,
		headerLength + clientIdBytes.length + requestIdBytes.length,
	);

	return plaintext;
}

function buildProxyBinaryFrame(
	kind: number,
	clientId: string,
	plaintext: Buffer,
) {
	const clientIdBytes = Buffer.from(clientId);
	if (clientIdBytes.length > 255) {
		throw new Error("Client id is too large for proxy binary frame");
	}

	const { nonce, ciphertext } = encryptBytes(plaintext);
	const frame = Buffer.allocUnsafe(
		PROXY_BINARY_HEADER_BYTES + clientIdBytes.length + ciphertext.length,
	);
	PROXY_BINARY_MAGIC.copy(frame, 0);
	frame.writeUInt8(PROXY_BINARY_VERSION, 4);
	frame.writeUInt8(kind, 5);
	frame.writeUInt8(clientIdBytes.length, 6);
	Buffer.from(nonce).copy(frame, 7);
	clientIdBytes.copy(frame, PROXY_BINARY_HEADER_BYTES);
	Buffer.from(ciphertext).copy(
		frame,
		PROXY_BINARY_HEADER_BYTES + clientIdBytes.length,
	);

	return frame;
}

function sendHttpResponseData(
	conn: Connection,
	clientId: string,
	requestId: string,
	chunkIndex: number,
	chunk: Buffer,
): boolean {
	if (!conn.clients.isConnected(clientId)) {
		return false;
	}

	const plaintext = buildHttpResponseDataPlaintext(
		clientId,
		requestId,
		chunkIndex,
		chunk,
	);
	return conn.sendBinary(
		buildProxyBinaryFrame(
			PROXY_BINARY_KIND_HTTP_RESPONSE_DATA,
			clientId,
			plaintext,
		),
	);
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
				error: "Only localhost URLs (http/https) are allowed",
				data: {
					requestId,
				},
			});
			return;
		}

		const initialBody = body
			? Buffer.from(body, bodyEncoding === "base64" ? "base64" : "utf-8")
			: undefined;
		const redirectCookies = new Map<string, string>();
		const redirectSetCookies: string[] = [];
		let redirectCount = 0;

		const sendEnd = (error?: string) => {
			activeRequests.delete(requestId);
			conn.send({
				type: MsgType.HTTP_RESPONSE_END,
				clientId,
				...(error ? { error } : {}),
				data: { requestId },
			});
		};

		const startRequest = (
			currentUrl: URL,
			currentMethod: string,
			currentBody: Buffer | undefined,
		) => {
			const reqOptions: http.RequestOptions = {
				hostname: currentUrl.hostname,
				port: currentUrl.port || (currentUrl.protocol === "https:" ? 443 : 80),
				path: currentUrl.pathname + currentUrl.search,
				method: currentMethod,
				agent: currentUrl.protocol === "https:" ? httpsAgent : httpAgent,
				headers: buildRequestHeaders(
					headers,
					currentUrl,
					currentBody !== undefined,
					redirectCookies,
				),
			};

			const request =
				currentUrl.protocol === "https:" ? httpsRequest : httpRequest;
			const req = request(reqOptions, (res) => {
				if (shouldRedirect(res)) {
					const redirectUrl = resolveRedirectUrl(
						getHeader(res.headers, "location"),
						currentUrl,
					);

					if (redirectUrl && redirectCount < MAX_REDIRECTS) {
						rememberSetCookies(redirectCookies, res.headers["set-cookie"]);
						if (res.headers["set-cookie"]) {
							redirectSetCookies.push(...res.headers["set-cookie"]);
						}
						redirectCount++;
						const next = nextRedirectMethod(res.statusCode ?? 0, currentMethod);
						drainResponse(res, () => {
							startRequest(
								redirectUrl,
								next.method,
								next.keepBody ? currentBody : undefined,
							);
						});
						return;
					}
				}

				// Send response headers
				const responseHeaders: Record<string, string | string[]> = {};
				for (const [key, value] of Object.entries(res.headers)) {
					if (value !== undefined) {
						responseHeaders[key] = value;
					}
				}
				if (redirectSetCookies.length > 0) {
					const finalSetCookie = res.headers["set-cookie"] ?? [];
					responseHeaders["set-cookie"] = [
						...redirectSetCookies,
						...finalSetCookie,
					];
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
				let responseBytesSent = 0;

				const sendData = (data: Buffer) => {
					let offset = 0;
					while (offset < data.length) {
						const maxChunkBytes =
							responseBytesSent < INITIAL_RESPONSE_WINDOW_BYTES
								? INITIAL_HTTP_RESPONSE_CHUNK_BYTES
								: STEADY_STATE_HTTP_RESPONSE_CHUNK_BYTES;
						const chunk = data.subarray(offset, offset + maxChunkBytes);
						responseBytesSent += chunk.length;
						offset += chunk.length;

						const sent = sendHttpResponseData(
							conn,
							clientId,
							requestId,
							chunkIndex++,
							chunk,
						);
						if (!sent) {
							return false;
						}
					}

					return true;
				};

				res.on("data", (chunk: Buffer) => {
					if (!sendData(chunk)) {
						res.destroy(new Error("Failed to send proxy response data"));
						return;
					}
					maybePauseForBackpressure(conn, res);
				});

				res.on("end", () => {
					sendEnd();
				});

				res.on("error", (err) => {
					sendEnd(err.message);
				});
			});

			req.on("error", (err) => {
				sendEnd(err.message);
			});

			activeRequests.set(requestId, req);

			// Write request body if present
			if (currentBody) {
				req.write(currentBody);
			}

			req.end();
		};

		startRequest(url, method.toUpperCase(), initialBody);
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
			perMessageDeflate: false,
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
				const buf = toBuffer(data);
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

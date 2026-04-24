import fs, { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import type { AiMessage, AiMessagePart, AiSession } from "@shellular/protocol";
import { logger } from "@/logger";
import type {
	AIProvider,
	AiEventEmitter,
	CodexPromptOptions,
	FileAttachment,
	ModelSelector,
	ProviderInfo,
	ShareInfo,
} from "./interface";

interface WorkspaceFolderJson {
	folder?: string;
}

interface ChatEntry {
	role: "user" | "assistant";
	text: string;
	requestId: string;
	timestamp: number;
	sessionId?: string;
}

interface SessionMeta {
	sessionId: string;
	workspacePath: string;
	title: string;
	creationDate: number;
	model: string;
	filePath: string;
	lastModified: number;
}

interface SessionListItem {
	id: string;
	title: string;
	workspacePath: string;
	creationDate: number;
	lastModified: number;
	model: string;
	backend: string;
}

interface CopilotMessageEventProperties {
	sessionId?: string;
	clientId?: string;
	role?: string;
	text?: string;
	timestamp?: number;
	requestId?: string;
}

interface CopilotTokenEventProperties {
	sessionId?: string;
	clientId?: string;
	token?: string;
}

interface CopilotErrorEventProperties {
	sessionId?: string;
	clientId?: string;
	error?: string;
}

interface ReferenceLocation {
	range: {
		startLineNumber: number;
		startColumn: number;
		endLineNumber: number;
		endColumn: number;
	};
	uri: {
		path: string;
		scheme: string;
	};
}

type CopilotEvent =
	| { type: "message"; properties: CopilotMessageEventProperties }
	| { type: "token"; properties: CopilotTokenEventProperties }
	| { type: "end"; properties: { sessionId?: string; clientId?: string } }
	| { type: "error"; properties: CopilotErrorEventProperties };

const VSCODE_VARIANTS = ["Code", "Code - Insiders", "VSCodium"];
const MAX_CHAT_HISTORY_PER_CLIENT = 200;
const EXTENSION_LOCK_PATH = path.join(os.tmpdir(), "shellular-copilot.lock");
const EXTENSION_SOCK_PATH = path.join(os.tmpdir(), "shellular-copilot.sock");
const chatStore = new Map<string, ChatEntry[]>();
const tokenAccumulator = new Map<string, string>();

let activeEmitter: AiEventEmitter | null = null;

export class CopilotProvider implements AIProvider {
	async init(): Promise<void> {
		logger.debug("CopilotProvider initialized");
	}

	async destroy(): Promise<void> {
		activeEmitter = null;
		tokenAccumulator.clear();
	}

	subscribe(emitter: AiEventEmitter): () => void {
		activeEmitter = emitter;
		return () => {
			activeEmitter = null;
		};
	}

	async createSession(_clientId?: string, _title?: string): Promise<AiSession> {
		throw new Error(
			"Creating sessions is not supported for Copilot. Start a new session from VS Code.",
		);
	}

	async listSessions(_clientId: string) {
		const vsSessions = await discoverSessions();

		const mergedSessions = new Map<string, SessionListItem>();

		for (const vs of vsSessions) {
			mergedSessions.set(vs.sessionId, {
				id: vs.sessionId,
				title: vs.title,
				workspacePath: vs.workspacePath,
				creationDate: vs.creationDate,
				lastModified: vs.lastModified,
				model: vs.model,
				backend: "copilot",
			});
		}

		const sessions: AiSession[] = Array.from(vsSessions.values())
			.sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0))
			.map((s) => ({
				title: s.title,
				model: s.model,
				id: s.sessionId,
				createdAt: s.creationDate,
				updatedAt: s.lastModified,
				workspacePath: s.workspacePath,
			}));

		return sessions;
	}

	async getSession(_clientId: string, id: string) {
		const vsSessions = await discoverSessions();

		const vsSession = vsSessions.find((s) => s.sessionId === id);
		if (vsSession) {
			return {
				model: vsSession.model,
				title: vsSession.title,
				id: vsSession.sessionId,
				createdAt: vsSession.creationDate,
				updatedAt: vsSession.lastModified,
				workspacePath: vsSession.workspacePath,
			};
		}

		throw new Error(`Session ${id} not found`);
	}

	async deleteSession(_clientId: string, _id: string): Promise<boolean> {
		throw new Error(
			"Deleting sessions is not supported for Copilot. Delete the session from VS Code.",
		);
	}

	async getMessages(_clientId: string, sessionId: string) {
		const vsSessions = await discoverSessions();
		const vsSession = vsSessions.find((s) => s.sessionId === sessionId);

		if (!vsSession) {
			throw new Error(`Session ${sessionId} not found`);
		}

		// For new chat sessions, return empty list
		if (vsSession.sessionId === "new") {
			return [];
		}

		let raw: string;
		try {
			raw = await readFile(vsSession.filePath, "utf-8");
		} catch {
			throw new Error(`Failed to read session file for session ${sessionId}`);
		}

		const lines = raw.split("\n").filter((l) => l.trim());
		if (lines.length === 0) {
			return [];
		}

		const messages: AiMessage[] = [];

		for (const line of lines) {
			let entry: Record<string, unknown>;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}

			if (entry.kind === 0) {
				const v = entry.v as Record<string, unknown>;
				if (Array.isArray(v.requests)) {
					for (const req of v.requests) {
						messages.push(...formatRequest(req));
					}
				}

				continue;
			}

			const keys = entry.k as Array<string | number>;
			const [key1, key2, key3] = keys;

			if (key1 === "requests" && key2 === undefined && key3 === undefined) {
				if (Array.isArray(entry.v)) {
					for (const req of entry.v) {
						messages.push(...formatRequest(req));
					}
				}
			} else if (
				key1 === "requests" &&
				typeof key2 === "number" &&
				key3 === "response"
			) {
				if (Array.isArray(entry.v)) {
					const lastMessage = messages[messages.length - 1];
					if (lastMessage) {
						lastMessage.parts = [
							...(lastMessage.parts || []),
							...mapResponseToParts(entry.v as Array<Record<string, unknown>>),
						];
					}
				}
			}
		}

		return messages;
	}

	async prompt(
		clientId: string,
		sessionId: string,
		text: string,
		_model?: ModelSelector,
		_agent?: string,
		_files?: FileAttachment[],
		_codexOptions?: CodexPromptOptions,
	): Promise<{ ack: true }> {
		if (!clientId) {
			throw new Error("Copilot client ID is required to send a prompt");
		}

		const requestId = `copilot_${Math.random().toString(36).slice(2, 10)}`;

		sendViaExtension(clientId, requestId, text, _model?.modelID, sessionId);

		return { ack: true };
	}

	async abort(
		_clientId: string,
		_sessionId: string,
	): Promise<Record<string, never>> {
		// Copilot doesn't support aborting via extension bridge
		throw new Error("Aborting Copilot prompts is not supported");
	}

	async agents(_clientId: string) {
		return [];
	}

	async providers(_clientId: string): Promise<ProviderInfo> {
		return {
			providers: [{ id: "copilot", name: "GitHub Copilot" }],
			default: {},
		};
	}

	async setAuth(): Promise<Record<string, never>> {
		throw new Error("Copilot authentication is handled in VS Code");
	}

	async command(): Promise<{ result: unknown }> {
		throw new Error("Copilot does not support commands");
	}

	async revert(): Promise<Record<string, never>> {
		throw new Error("Copilot does not support revert");
	}

	async unrevert(): Promise<Record<string, never>> {
		throw new Error("Copilot does not support unrevert");
	}

	async share(): Promise<{ share: ShareInfo }> {
		return { share: {} };
	}

	async permissionReply(): Promise<Record<string, never>> {
		throw new Error("Copilot does not support permissions");
	}

	async questionReply(): Promise<Record<string, never>> {
		throw new Error("Copilot does not support questions");
	}

	async questionReject(): Promise<Record<string, never>> {
		throw new Error("Copilot does not support questions");
	}
}

function addChatEntry(clientId: string, entry: ChatEntry): void {
	const entries = chatStore.get(clientId) ?? [];
	entries.push(entry);
	if (entries.length > MAX_CHAT_HISTORY_PER_CLIENT) {
		entries.splice(0, entries.length - MAX_CHAT_HISTORY_PER_CLIENT);
	}
	chatStore.set(clientId, entries);
	notifyExtensionChatHistory(clientId);
}

function getWorkspaceStorageRoots(): string[] {
	const platform = os.platform();
	const home = os.homedir();
	const roots: string[] = [];

	for (const variant of VSCODE_VARIANTS) {
		let base: string;
		if (platform === "darwin") {
			base = path.join(home, "Library", "Application Support", variant);
		} else if (platform === "win32") {
			base = path.join(
				process.env.APPDATA ?? path.join(home, "AppData", "Roaming"),
				variant,
			);
		} else {
			base = path.join(home, ".config", variant);
		}
		roots.push(path.join(base, "User", "workspaceStorage"));
	}

	return roots;
}

async function discoverSessions(): Promise<SessionMeta[]> {
	const roots = getWorkspaceStorageRoots();
	const sessions: SessionMeta[] = [];

	for (const root of roots) {
		if (!fs.existsSync(root)) continue;

		let hashes: string[];
		try {
			hashes = fs.readdirSync(root);
		} catch {
			continue;
		}

		for (const hash of hashes) {
			const hashDir = path.join(root, hash);

			// Resolve workspace folder path
			let workspacePath = "";
			try {
				const wsJson = parseJsonFile<WorkspaceFolderJson>(
					path.join(hashDir, "workspace.json"),
				);
				if (wsJson?.folder) {
					workspacePath = decodeURIComponent(
						wsJson.folder.replace(/^file:\/\//, ""),
					);
				}
			} catch {
				continue;
			}

			const chatSessionsDir = path.join(hashDir, "chatSessions");
			if (!fs.existsSync(chatSessionsDir)) continue;

			let files: string[];
			try {
				files = fs
					.readdirSync(chatSessionsDir)
					.filter((f) => f.endsWith(".jsonl"));
			} catch {
				continue;
			}

			for (const file of files) {
				const filePath = path.join(chatSessionsDir, file);
				const parsed = await getSessionInfo(filePath);

				if (!parsed) continue;

				let lastModified = parsed.creationDate as number;
				try {
					lastModified = fs.statSync(filePath).mtimeMs;
				} catch {
					// fall back to creationDate
				}

				sessions.push({
					sessionId: parsed?.sessionId as string,
					workspacePath,
					title:
						(parsed?.customTitle as string) ||
						(parsed?.sessionId as string) ||
						"Untitled Session",
					creationDate: parsed?.creationDate as number,
					model: (parsed?.model as string) || "",
					filePath,
					lastModified,
				});
			}
		}
	}

	// Most recently active session first
	sessions.sort((a, b) => b.lastModified - a.lastModified);

	return sessions;
}

async function getSessionInfo(
	filePath: string,
): Promise<Record<string, unknown> | null> {
	const readStream = createReadStream(filePath, { encoding: "utf-8" });
	const readLine = readline.createInterface({ input: readStream });

	let lineOne: Record<string, unknown> | null = null;
	let lineTwo: Record<string, unknown> | null = null;

	for await (const line of readLine) {
		if (!line.trim()) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line);
			if (!lineOne) {
				lineOne = entry;
			} else if (!lineTwo) {
				lineTwo = entry;
			} else {
				break;
			}
		} catch {
			// skip invalid lines
		}
	}

	let customTitle = (lineOne?.v as Record<string, unknown>)?.customTitle;

	if (
		!customTitle &&
		lineTwo?.kind === 1 &&
		(lineTwo.k as string[]).length === 1 &&
		(lineTwo.k as string[])[0] === "customTitle"
	) {
		customTitle = typeof lineTwo.v === "string" ? lineTwo.v : undefined;
	}

	const result = lineOne?.v as Record<string, unknown> | undefined;
	if (result && typeof result === "object") {
		delete result.requests; // can be large, and we only need metadata from the header
		delete result.inputState; // can be large and nested
		delete result.pendingRequest;

		result.customTitle = customTitle;
		return result;
	}

	return null;
}

function getExtensionSocketPath(): string | null {
	try {
		const lock = fs.readFileSync(EXTENSION_LOCK_PATH, "utf-8").trim();
		const sockPath = lock || EXTENSION_SOCK_PATH;
		if (fs.existsSync(sockPath)) return sockPath;
	} catch {
		// fall through
	}
	if (fs.existsSync(EXTENSION_SOCK_PATH)) return EXTENSION_SOCK_PATH;
	return null;
}

function sendViaExtension(
	clientId: string,
	requestId: string,
	prompt: string,
	modelFamily: string | undefined,
	shellularSessionId: string,
) {
	const sockPath = getExtensionSocketPath();
	if (!sockPath) {
		handleCopilotMessageEvent(clientId, {
			type: "error",
			properties: {
				sessionId: shellularSessionId,
				clientId,
				error:
					"Shellular VS Code extension is not running. Install it with: shellular --install-vs-plugin",
			},
		});
		return;
	}

	const socket = net.connect(sockPath);
	let buffer = "";
	let connected = false;

	socket.on("connect", () => {
		connected = true;
		const payload = `${JSON.stringify({
			type: "send",
			requestId,
			prompt,
			modelFamily,
			clientId,
		})}\n`;
		socket.write(payload);
	});

	socket.on("data", (chunk) => {
		buffer += chunk.toString("utf-8");
		const parts = buffer.split("\n");
		buffer = parts.pop() ?? "";

		for (const part of parts) {
			if (!part.trim()) continue;
			let msg: {
				type: string;
				requestId?: string;
				text?: string;
				error?: string;
			};
			try {
				msg = JSON.parse(part);
			} catch {
				continue;
			}

			if (msg.type === "token" && typeof msg.text === "string") {
				tokenAccumulator.set(
					requestId,
					(tokenAccumulator.get(requestId) ?? "") + msg.text,
				);
				handleCopilotMessageEvent(clientId, {
					type: "token",
					properties: {
						sessionId: shellularSessionId,
						clientId,
						token: msg.text,
					},
				});
			} else if (msg.type === "done") {
				const fullText = tokenAccumulator.get(requestId) ?? "";
				tokenAccumulator.delete(requestId);
				if (fullText) {
					const assistantEntry: ChatEntry = {
						role: "assistant",
						text: fullText,
						requestId,
						timestamp: Date.now(),
					};
					addChatEntry(clientId, assistantEntry);
				}
				handleCopilotMessageEvent(clientId, {
					type: "end",
					properties: { sessionId: shellularSessionId, clientId },
				});
				socket.destroy();
			} else if (msg.type === "error") {
				tokenAccumulator.delete(requestId);
				handleCopilotMessageEvent(clientId, {
					type: "error",
					properties: {
						sessionId: shellularSessionId,
						clientId,
						error: msg.error ?? "Unknown error from VS Code extension",
					},
				});
				socket.destroy();
			}
		}
	});

	socket.on("error", (err) => {
		if (!connected) {
			logger.error("[copilot] Extension socket error:", err.message);
		}
		handleCopilotMessageEvent(clientId, {
			type: "error",
			properties: {
				sessionId: shellularSessionId,
				clientId,
				error: `Extension socket error: ${err.message}`,
			},
		});
	});
}

export function notifyExtensionChatHistory(clientId: string): void {
	const messages = chatStore.get(clientId);
	if (!messages || messages.length === 0) return;
	sendOneWayToExtension({
		type: "chat_history",
		clientId,
		messages,
	});
}

export function notifyExtensionClientPresence(
	clientId: string,
	connected: boolean,
	platform?: string,
	appVersion?: string,
): void {
	sendOneWayToExtension({
		type: "client_presence",
		clientId,
		connected,
		platform,
		appVersion,
	});
}

export function notifyExtensionCliInfo(input: {
	version: string;
	hostname: string;
	platform: string;
	workDir: string;
	sessionId: string;
}): void {
	sendOneWayToExtension({
		type: "cli_info",
		version: input.version,
		hostname: input.hostname,
		platform: input.platform,
		workDir: input.workDir,
		sessionId: input.sessionId,
	});
}

export function notifyExtensionClientsSnapshot(
	clients: Array<{
		clientId: string;
		platform: string;
		appVersion: string;
	}>,
): void {
	sendOneWayToExtension({
		type: "client_snapshot",
		clients,
	});
}

function sendOneWayToExtension(payload: Record<string, unknown>): void {
	const sockPath = getExtensionSocketPath();
	if (!sockPath) return;

	const socket = net.connect(sockPath);
	let done = false;

	const finish = () => {
		if (done) return;
		done = true;
		socket.destroy();
	};

	socket.on("connect", () => {
		socket.write(`${JSON.stringify(payload)}\n`);
	});

	socket.on("data", () => {
		finish();
	});

	socket.on("error", () => {
		finish();
	});

	socket.on("close", () => {
		finish();
	});
}

export function handleCopilotMessageEvent(
	clientId: string,
	msg: CopilotEvent,
): void {
	if (!activeEmitter) return;

	const { type, properties } = msg;

	if (type === "message") {
		activeEmitter(clientId, {
			type: "message",
			properties: {
				id: properties.requestId,
				role: properties.role,
				text: properties.text,
				timestamp: properties.timestamp,
				sessionId: properties.sessionId,
				clientId: properties.clientId,
			},
		});
	}

	if (type === "token") {
		activeEmitter(clientId, {
			type: "token",
			properties: {
				sessionId: properties.sessionId,
				clientId: properties.clientId,
				text: properties.token,
			},
		});
	}

	if (type === "end") {
		activeEmitter(clientId, {
			type: "end",
			properties: {
				sessionId: properties.sessionId,
				clientId: properties.clientId,
			},
		});
	}

	if (type === "error") {
		activeEmitter(clientId, {
			type: "error",
			properties: {
				sessionId: properties.sessionId,
				clientId: properties.clientId,
				error: properties.error,
			},
		});
	}
}

function parseJsonFile<T>(filePath: string): T | null {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

function mapResponseToParts(
	response: Array<Record<string, unknown>>,
): AiMessagePart[] {
	const parts: AiMessagePart[] = [];

	for (const part of response) {
		const kind = (part.kind as string) || "unknown";

		switch (kind) {
			case "mcpServersStarting":
				parts.push({
					type: "tool_call",
					name: kind,
					arguments: "",
					title: "",
					id: (part.id as string) || "",
				});
				break;
			case "thinking": {
				if (typeof part.value === "string" && part.value.trim()) {
					parts.push({
						type: "reasoning",
						content: part.value.trim(),
					});
				}
				break;
			}
			case "toolInvocationSerialized":
				if (part.presentation !== "hidden") {
					parts.push({
						type: "tool_call",
						name: (part.toolName as string) || kind,
						arguments: "",
						title: fixEmptyMarkdownFileLinks(
							(part.generatedTitle as string) ||
								(part.pastTenseMessage as { value: string })?.value ||
								(part.invocationMessage as { value: string })?.value ||
								(part.invocationMessage as string) ||
								"",
						),
						id: (part.id as string) || "",
					});
				}
				break;
			case "inlineReference": {
				const location = ((part.inlineReference as Record<string, unknown>)
					.location || part.inlineReference) as ReferenceLocation | undefined;

				if (location?.uri?.path && location.range) {
					parts.push({
						type: "file_reference",
						path: location.uri.path,
						range: {
							start: `${location.range.startLineNumber}:${location.range.startColumn}`,
							end: `${location.range.endLineNumber}:${location.range.endColumn}`,
						},
					});
				} else if ((location as unknown as Record<string, unknown>)?.path) {
					parts.push({
						type: "file_reference",
						path: (location as unknown as Record<string, unknown>)
							.path as string,
					});
				} else {
					console.warn("Missing location for inlineReference part:", part);
				}

				break;
			}
			case "textEditGroup": {
				parts.push({
					type: "file_change",
					path: ((part.uri as Record<string, unknown>)?.path as string) || "",
					kind: "edit",
				});
				break;
			}
			case "progressTaskSerialized":
				break;
			default: {
				const text = typeof part.value === "string" ? part.value : "";
				if (text.trim()) {
					parts.push({
						type: "text",
						text,
					});
				}
				break;
			}
		}
	}

	return parts;
}

function formatRequest(req: Record<string, unknown>): AiMessage[] {
	const messages: AiMessage[] = [];
	const message = req.message as Record<string, unknown>;
	const userText = (message?.value || message?.text) as string | undefined;

	if (typeof userText === "string") {
		messages.push({
			id: req.requestId as string,
			role: "user",
			timestamp: req.timestamp as number,
			parts: [
				{
					type: "text",
					text: userText,
				},
			],
		});
	}

	if (Array.isArray(req.response)) {
		messages.push({
			id: req.responseId as string,
			role: "assistant",
			timestamp: (req.timestamp as number) + 1,
			parts: mapResponseToParts(req.response),
		});
	}

	return messages;
}

function fixEmptyMarkdownFileLinks(line: string): string {
	try {
		const pattern = /\[\]\((file:\/\/\/[^\s)]+)\)/g;

		const fixed = line.replace(pattern, (_match, rawUrl: string) => {
			try {
				const url = new URL(rawUrl);
				const pathname = decodeURIComponent(url.pathname);

				// Get filename from path, fallback to "file"
				const segments = pathname.split("/").filter(Boolean);
				const fileName =
					segments.length > 0 ? segments[segments.length - 1] : "file";
				return `[${fileName}](${rawUrl})`;
			} catch {
				// If URL parsing fails, keep original
				return _match;
			}
		});

		return fixed;
	} catch (error) {
		console.error("Error fixing empty markdown file links:", error);
		return line;
	}
}

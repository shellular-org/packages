import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

const SOCK_PATH = path.join(os.tmpdir(), "shellular-copilot.sock");
const LOCK_PATH = path.join(os.tmpdir(), "shellular-copilot.lock");

// Newline-delimited JSON messages from the CLI:
// { type: "send",     requestId: string, prompt: string, modelFamily?: string }
// { type: "new_chat" }
// { type: "client_presence", clientId: string, connected: boolean, platform?: string, appVersion?: string }
// { type: "cli_info", version: string, hostname: string, platform: string, workDir: string, sessionId: string }
// { type: "client_snapshot", clients: Array<{ clientId: string, platform: string, appVersion: string }> }
// { type: "chat_history", clientId: string, messages: Array<{ role, text, requestId, timestamp }> }
// Replies to CLI:
// { type: "token", requestId: string, text: string }
// { type: "done",  requestId: string }
// { type: "error", requestId: string, error: string }

interface ChatHistoryMessage {
	role: "user" | "assistant";
	text: string;
	requestId: string;
	timestamp: number;
}

interface SendRequest {
	type: "send";
	requestId: string;
	prompt: string;
	modelFamily?: string;
	clientId?: string;
}

interface NewChatRequest {
	type: "new_chat";
	clientId?: string;
}

interface ClientPresenceRequest {
	type: "client_presence";
	clientId: string;
	connected: boolean;
	platform?: string;
	appVersion?: string;
}

interface CliInfoRequest {
	type: "cli_info";
	version: string;
	hostname: string;
	platform: string;
	workDir: string;
	sessionId: string;
}

interface ClientSnapshotRequest {
	type: "client_snapshot";
	clients: Array<{
		clientId: string;
		platform: string;
		appVersion: string;
	}>;
}

interface ChatHistoryRequest {
	type: "chat_history";
	clientId: string;
	messages: ChatHistoryMessage[];
}

type IncomingRequest =
	| SendRequest
	| NewChatRequest
	| ClientPresenceRequest
	| CliInfoRequest
	| ClientSnapshotRequest
	| ChatHistoryRequest;

interface ConnectedDevice {
	id: string;
	label: string;
	clientId?: string;
	platform?: string;
	appVersion?: string;
	connectedAt: number;
	lastSeenAt: number;
	requestCount: number;
	// Last few chat turns for display in sidebar
	chatMessages: ChatHistoryMessage[];
}

interface CliInfoState {
	version: string;
	hostname: string;
	platform: string;
	workDir: string;
	sessionId: string;
	updatedAt: number;
}

interface RequestLogEntry {
	at: number;
	type: IncomingRequest["type"];
	clientId?: string;
	message: string;
}

function formatTime(ts: number): string {
	return new Date(ts).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

function formatDateTime(ts: number): string {
	return new Date(ts).toLocaleString();
}

function formatAgo(ts: number): string {
	const delta = Date.now() - ts;
	if (delta < 1000) return "just now";
	if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
	if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
	return `${Math.floor(delta / 3_600_000)}h ago`;
}

// Section IDs used to dispatch getChildren
const ID_SECTION_CLI = "section:cli";
const ID_SECTION_DEVICES = "section:devices";
const ID_SECTION_LOGS = "section:logs";

// contextValue for package.json menu contributions
const CTX_LOGS_SECTION = "shellularLogsSection";

function makeDetail(
	label: string,
	value: string,
	icon: string,
): vscode.TreeItem {
	const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
	item.description = value;
	item.iconPath = new vscode.ThemeIcon(icon);
	return item;
}

class DevicesTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
	private readonly changeEmitter = new vscode.EventEmitter<
		vscode.TreeItem | undefined
	>();
	readonly onDidChangeTreeData = this.changeEmitter.event;

	private bridgeListening = false;
	private readonly devices = new Map<string, ConnectedDevice>();
	private cliInfo: CliInfoState | null = null;
	private readonly requestLogs: RequestLogEntry[] = [];
	private readonly maxRequestLogs = 100;

	setBridgeListening(value: boolean): void {
		this.bridgeListening = value;
		this.refresh();
	}

	setCliInfo(info: CliInfoState): void {
		this.cliInfo = info;
		this.refresh();
	}

	appendRequestLog(req: IncomingRequest): void {
		const at = Date.now();
		let message: string = req.type;
		if (req.type === "send") {
			const preview = req.prompt.replace(/\s+/g, " ").slice(0, 60);
			message = `${preview}${req.prompt.length > 60 ? "…" : ""}`;
		} else if (req.type === "new_chat") {
			message = "New chat started";
		} else if (req.type === "client_presence") {
			message = req.connected
				? `${req.clientId} connected`
				: `${req.clientId} disconnected`;
		} else if (req.type === "cli_info") {
			message = `CLI v${req.version} on ${req.hostname}`;
		} else if (req.type === "client_snapshot") {
			// skip noisy snapshot events from the log
			return;
		} else if (req.type === "chat_history") {
			// skip – not a user-visible event
			return;
		}

		this.requestLogs.unshift({
			at,
			type: req.type,
			clientId:
				req.type === "send" || req.type === "new_chat"
					? req.clientId
					: req.type === "client_presence"
						? req.clientId
						: undefined,
			message,
		});
		if (this.requestLogs.length > this.maxRequestLogs) {
			this.requestLogs.length = this.maxRequestLogs;
		}
		this.refresh();
	}

	setClientPresence(
		clientId: string,
		connected: boolean,
		platform?: string,
		appVersion?: string,
	): void {
		if (!connected) {
			this.devices.delete(clientId);
			this.refresh();
			return;
		}

		const now = Date.now();
		const existing = this.devices.get(clientId);
		if (existing) {
			existing.lastSeenAt = now;
			existing.platform = platform ?? existing.platform;
			existing.appVersion = appVersion ?? existing.appVersion;
			this.refresh();
			return;
		}

		this.devices.set(clientId, {
			id: clientId,
			label: `Client ${clientId}`,
			clientId,
			platform,
			appVersion,
			connectedAt: now,
			lastSeenAt: now,
			requestCount: 0,
			chatMessages: this.pendingChatHistory.get(clientId) ?? [],
		});
		this.pendingChatHistory.delete(clientId);
		this.refresh();
	}

	setClientsSnapshot(
		clients: Array<{
			clientId: string;
			platform: string;
			appVersion: string;
		}>,
	): void {
		const now = Date.now();
		const incoming = new Set(clients.map((c) => c.clientId));

		for (const id of Array.from(this.devices.keys())) {
			if (!incoming.has(id)) {
				this.devices.delete(id);
			}
		}

		for (const c of clients) {
			const existing = this.devices.get(c.clientId);
			if (existing) {
				existing.lastSeenAt = now;
				existing.platform = c.platform || existing.platform;
				existing.appVersion = c.appVersion || existing.appVersion;
			} else {
				this.devices.set(c.clientId, {
					id: c.clientId,
					label: `Client ${c.clientId}`,
					clientId: c.clientId,
					platform: c.platform,
					appVersion: c.appVersion,
					connectedAt: now,
					lastSeenAt: now,
					requestCount: 0,
					chatMessages: [],
				});
			}
		}

		this.refresh();
	}

	noteDeviceActivity(deviceId: string): void {
		const device = this.devices.get(deviceId);
		if (!device) return;
		device.lastSeenAt = Date.now();
		device.requestCount += 1;
		this.refresh();
	}

	setChatHistory(clientId: string, messages: ChatHistoryMessage[]): void {
		const device = this.devices.get(clientId);
		if (device) {
			// Keep the last 20 messages for sidebar display
			device.chatMessages = messages.slice(-20);
		} else {
			// Device not yet in map — store temporarily until presence arrives
			this.pendingChatHistory.set(clientId, messages.slice(-20));
		}
		this.refresh();
	}

	// Temporary buffer for history arriving before device presence
	private readonly pendingChatHistory = new Map<string, ChatHistoryMessage[]>();

	clearLogs(): void {
		this.requestLogs.length = 0;
		this.refresh();
	}

	clear(): void {
		this.devices.clear();
		this.requestLogs.length = 0;
		this.cliInfo = null;
		this.refresh();
	}

	refresh(): void {
		this.changeEmitter.fire(undefined);
	}

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(
		element?: vscode.TreeItem,
	): vscode.ProviderResult<vscode.TreeItem[]> {
		if (!element) return this.getRootItems();

		const id = element.id;
		if (id === ID_SECTION_CLI) return this.getCliChildren();
		if (id === ID_SECTION_DEVICES) return this.getDeviceChildren();
		if (id === ID_SECTION_LOGS) return this.getLogChildren();
		if (id?.startsWith("device:")) {
			return this.getDeviceDetailChildren(id.slice("device:".length));
		}

		return [];
	}

	private getRootItems(): vscode.TreeItem[] {
		const items: vscode.TreeItem[] = [];

		// ── Bridge status ──────────────────────────────────────────────────
		const bridge = new vscode.TreeItem(
			this.bridgeListening ? "Bridge: Active" : "Bridge: Stopped",
			vscode.TreeItemCollapsibleState.None,
		);
		bridge.iconPath = new vscode.ThemeIcon(
			this.bridgeListening ? "pass-filled" : "error",
		);
		bridge.description = this.bridgeListening ? "Listening" : "Inactive";
		bridge.tooltip = this.bridgeListening
			? `Socket listening on ${SOCK_PATH}`
			: "Bridge socket is not active. Reload VS Code to restart.";
		items.push(bridge);

		// ── CLI section ────────────────────────────────────────────────────
		const hasCliInfo = this.cliInfo !== null;
		const cli = new vscode.TreeItem(
			hasCliInfo ? `CLI  v${this.cliInfo?.version}` : "CLI",
			hasCliInfo
				? vscode.TreeItemCollapsibleState.Collapsed
				: vscode.TreeItemCollapsibleState.None,
		);
		cli.id = ID_SECTION_CLI;
		cli.iconPath = new vscode.ThemeIcon("terminal-powershell");
		cli.description = hasCliInfo
			? `${this.cliInfo?.hostname}  ·  ${this.cliInfo?.platform}`
			: "Waiting for CLI…";
		cli.tooltip = hasCliInfo
			? new vscode.MarkdownString(
					`**Shellular CLI**\n\n` +
						`Version: \`${this.cliInfo?.version}\`\n\n` +
						`Host: ${this.cliInfo?.hostname}\n\n` +
						`Platform: ${this.cliInfo?.platform}\n\n` +
						`Directory: ${this.cliInfo?.workDir}\n\n` +
						`Session: \`${this.cliInfo?.sessionId}\``,
				)
			: "CLI has not connected yet.";
		items.push(cli);

		// ── Connected Devices section ──────────────────────────────────────
		const devCount = this.devices.size;
		const devSection = new vscode.TreeItem(
			devCount > 0 ? `Connected Devices  (${devCount})` : "Connected Devices",
			devCount > 0
				? vscode.TreeItemCollapsibleState.Expanded
				: vscode.TreeItemCollapsibleState.None,
		);
		devSection.id = ID_SECTION_DEVICES;
		devSection.iconPath = new vscode.ThemeIcon("device-mobile");
		devSection.description = devCount === 0 ? "None" : undefined;
		devSection.tooltip =
			devCount === 0
				? "No devices are currently connected."
				: `${devCount} device${devCount === 1 ? "" : "s"} connected`;
		items.push(devSection);

		// ── Activity Log section ───────────────────────────────────────────
		const logCount = this.requestLogs.length;
		const logsSection = new vscode.TreeItem(
			logCount > 0 ? `Activity Log  (${logCount})` : "Activity Log",
			logCount > 0
				? vscode.TreeItemCollapsibleState.Collapsed
				: vscode.TreeItemCollapsibleState.None,
		);
		logsSection.id = ID_SECTION_LOGS;
		logsSection.iconPath = new vscode.ThemeIcon("list-unordered");
		logsSection.contextValue = CTX_LOGS_SECTION;
		logsSection.description =
			logCount === 0 ? "No activity yet" : `${logCount} events`;
		logsSection.tooltip =
			logCount === 0 ? "No activity recorded yet." : "Recent extension events.";
		items.push(logsSection);

		return items;
	}

	private getCliChildren(): vscode.TreeItem[] {
		if (!this.cliInfo) return [];
		const { version, hostname, platform, workDir, sessionId, updatedAt } =
			this.cliInfo;
		return [
			makeDetail("Version", version, "tag"),
			makeDetail("Hostname", hostname, "server"),
			makeDetail("Platform", platform, "vm"),
			makeDetail("Directory", workDir, "folder-opened"),
			makeDetail(
				"Session",
				sessionId.length > 12 ? `${sessionId.slice(0, 12)}…` : sessionId,
				"key",
			),
			makeDetail("Last sync", formatAgo(updatedAt), "history"),
		];
	}

	private getDeviceChildren(): vscode.TreeItem[] {
		if (this.devices.size === 0) {
			const empty = new vscode.TreeItem(
				"No connected devices",
				vscode.TreeItemCollapsibleState.None,
			);
			empty.iconPath = new vscode.ThemeIcon("circle-slash");
			return [empty];
		}

		const sorted = Array.from(this.devices.values()).sort(
			(a, b) => b.connectedAt - a.connectedAt,
		);

		return sorted.map((device) => {
			const platformLabel = device.platform ?? "Unknown";
			const item = new vscode.TreeItem(
				platformLabel,
				vscode.TreeItemCollapsibleState.Collapsed,
			);
			item.id = `device:${device.clientId}`;
			item.iconPath = new vscode.ThemeIcon("vm-active");
			item.description = `${device.requestCount} req  ·  ${formatAgo(device.connectedAt)}`;
			item.contextValue = "shellularDevice";
			item.tooltip = new vscode.MarkdownString(
				`**${platformLabel}**\n\n` +
					`Client ID: \`${device.clientId}\`\n\n` +
					`App Version: ${device.appVersion ?? "unknown"}\n\n` +
					`Connected: ${formatDateTime(device.connectedAt)}\n\n` +
					`Last active: ${formatDateTime(device.lastSeenAt)}\n\n` +
					`Requests served: ${device.requestCount}`,
			);
			return item;
		});
	}

	private getDeviceDetailChildren(clientId: string): vscode.TreeItem[] {
		const device = this.devices.get(clientId);
		if (!device) return [];

		const details: vscode.TreeItem[] = [
			makeDetail("Client ID", device.clientId ?? clientId, "key"),
			makeDetail("Platform", device.platform ?? "unknown", "vm"),
			makeDetail("App Version", device.appVersion ?? "unknown", "tag"),
			makeDetail("Connected", formatDateTime(device.connectedAt), "plug"),
			makeDetail("Last active", formatAgo(device.lastSeenAt), "history"),
			makeDetail("Requests", String(device.requestCount), "pulse"),
		];

		// Chat history section
		if (device.chatMessages.length === 0) {
			details.push(makeDetail("Chat", "No history yet", "comment-discussion"));
		} else {
			const chatHeader = new vscode.TreeItem(
				`Chat  (${device.chatMessages.length} messages)`,
				vscode.TreeItemCollapsibleState.None,
			);
			chatHeader.iconPath = new vscode.ThemeIcon("comment-discussion");
			details.push(chatHeader);

			// Show last 5 turns (most recent last)
			const recent = device.chatMessages.slice(-5);
			for (const msg of recent) {
				const preview = msg.text.replace(/\s+/g, " ").slice(0, 60);
				const item = new vscode.TreeItem(
					`${msg.role === "user" ? "You" : "AI"}: ${preview}${msg.text.length > 60 ? "…" : ""}`,
					vscode.TreeItemCollapsibleState.None,
				);
				item.iconPath = new vscode.ThemeIcon(
					msg.role === "user" ? "account" : "hubot",
				);
				item.description = formatTime(msg.timestamp);
				item.tooltip = new vscode.MarkdownString(
					`**${msg.role === "user" ? "You" : "Copilot"}** — *${formatDateTime(msg.timestamp)}*\n\n${msg.text}`,
				);
				details.push(item);
			}
		}

		return details;
	}

	private getLogChildren(): vscode.TreeItem[] {
		if (this.requestLogs.length === 0) {
			const empty = new vscode.TreeItem(
				"No activity yet",
				vscode.TreeItemCollapsibleState.None,
			);
			empty.iconPath = new vscode.ThemeIcon("history");
			return [empty];
		}

		return this.requestLogs.slice(0, 50).map((log) => {
			const icon = this.getLogIcon(log.type);
			const item = new vscode.TreeItem(
				log.message,
				vscode.TreeItemCollapsibleState.None,
			);
			item.iconPath = icon;
			item.description = `${formatTime(log.at)}${log.clientId ? `  ·  ${log.clientId.slice(0, 8)}` : ""}`;
			item.tooltip = new vscode.MarkdownString(
				`**${log.type}**  ·  *${formatDateTime(log.at)}*\n\n` +
					`${log.message}` +
					(log.clientId ? `\n\nClient: \`${log.clientId}\`` : ""),
			);
			return item;
		});
	}

	private getLogIcon(type: IncomingRequest["type"]): vscode.ThemeIcon {
		switch (type) {
			case "send":
				return new vscode.ThemeIcon("comment-discussion");
			case "new_chat":
				return new vscode.ThemeIcon("add");
			case "client_presence":
				return new vscode.ThemeIcon("plug");
			case "cli_info":
				return new vscode.ThemeIcon("terminal");
			default:
				return new vscode.ThemeIcon("circle-filled");
		}
	}
}

async function handleRequest(
	req: SendRequest,
	socket: net.Socket,
	token: vscode.CancellationToken,
): Promise<void> {
	const { requestId, prompt, modelFamily } = req;

	const send = (msg: object) => {
		if (!socket.destroyed) {
			socket.write(`${JSON.stringify(msg)}\n`);
		}
	};

	// Select model
	const selector: vscode.LanguageModelChatSelector = modelFamily
		? { family: modelFamily }
		: {};
	const models = await vscode.lm.selectChatModels(selector);
	if (models.length === 0) {
		send({
			type: "error",
			requestId,
			error: `No language models available${modelFamily ? ` for family "${modelFamily}"` : ""}. Is GitHub Copilot active?`,
		});
		return;
	}

	const model = models[0];
	const messages = [vscode.LanguageModelChatMessage.User(prompt)];

	let response: vscode.LanguageModelChatResponse;
	try {
		response = await model.sendRequest(messages, {}, token);
	} catch (err) {
		send({
			type: "error",
			requestId,
			error: err instanceof Error ? err.message : String(err),
		});
		return;
	}

	try {
		for await (const chunk of response.text) {
			if (token.isCancellationRequested) break;
			send({ type: "token", requestId, text: chunk });
		}
		send({ type: "done", requestId });
	} catch (err) {
		send({
			type: "error",
			requestId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

let server: net.Server | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let devicesProvider: DevicesTreeProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
	outputChannel = vscode.window.createOutputChannel("Shellular CLI Bridge");
	context.subscriptions.push(outputChannel);

	devicesProvider = new DevicesTreeProvider();
	context.subscriptions.push(
		vscode.window.registerTreeDataProvider(
			"shellularBridge.devices",
			devicesProvider,
		),
	);

	// Remove stale socket file if left from a crashed previous run
	try {
		fs.unlinkSync(SOCK_PATH);
	} catch {
		// ignore ENOENT
	}

	server = net.createServer((socket) => {
		outputChannel?.appendLine("[bridge] Socket connection opened");

		const cancelSource = new vscode.CancellationTokenSource();
		let buffer = "";

		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf-8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				if (!line.trim()) continue;
				let req: IncomingRequest;
				try {
					req = JSON.parse(line) as IncomingRequest;
				} catch {
					outputChannel?.appendLine(`[bridge] Invalid JSON: ${line}`);
					continue;
				}

				devicesProvider?.appendRequestLog(req);

				if (req.type === "cli_info") {
					devicesProvider?.setCliInfo({
						version: req.version,
						hostname: req.hostname,
						platform: req.platform,
						workDir: req.workDir,
						sessionId: req.sessionId,
						updatedAt: Date.now(),
					});
					if (!socket.destroyed) {
						socket.write(`${JSON.stringify({ type: "done" })}\n`);
					}
					continue;
				}

				if (req.type === "client_snapshot") {
					devicesProvider?.setClientsSnapshot(req.clients);
					if (!socket.destroyed) {
						socket.write(`${JSON.stringify({ type: "done" })}\n`);
					}
					continue;
				}

				if (req.type === "client_presence") {
					devicesProvider?.setClientPresence(
						req.clientId,
						req.connected,
						req.platform,
						req.appVersion,
					);
					if (!socket.destroyed) {
						socket.write(`${JSON.stringify({ type: "done" })}\n`);
					}
					continue;
				}

				if (req.type === "chat_history") {
					devicesProvider?.setChatHistory(req.clientId, req.messages);
					if (!socket.destroyed) {
						socket.write(`${JSON.stringify({ type: "done" })}\n`);
					}
					continue;
				}

				if (req.clientId) {
					devicesProvider?.setClientPresence(req.clientId, true);
					devicesProvider?.noteDeviceActivity(req.clientId);
				}

				if (req.type === "send") {
					handleRequest(req, socket, cancelSource.token).catch((err) => {
						outputChannel?.appendLine(`[bridge] Unhandled error: ${err}`);
					});
				} else if (req.type === "new_chat") {
					// new_chat is a client-side concept: just ack so the client can reset its UI
					if (!socket.destroyed) {
						socket.write(`${JSON.stringify({ type: "done" })}\n`);
					}
				}
			}
		});

		socket.on("close", () => {
			cancelSource.cancel();
			cancelSource.dispose();
			outputChannel?.appendLine("[bridge] Socket connection closed");
		});

		socket.on("error", (err: Error) => {
			outputChannel?.appendLine(`[bridge] Socket error: ${err.message}`);
			cancelSource.cancel();
			cancelSource.dispose();
		});
	});

	server.listen(SOCK_PATH, () => {
		devicesProvider?.setBridgeListening(true);
		outputChannel?.appendLine(`[bridge] Listening on ${SOCK_PATH}`);
		// Write lock file so CLI knows where to connect
		try {
			fs.writeFileSync(LOCK_PATH, SOCK_PATH, "utf-8");
		} catch {
			// non-fatal
		}
	});

	server.on("error", (err: Error) => {
		devicesProvider?.setBridgeListening(false);
		outputChannel?.appendLine(`[bridge] Server error: ${err.message}`);
		vscode.window.showErrorMessage(
			`Shellular CLI Bridge failed to start: ${err.message}`,
		);
	});

	// Register manual start command (no-op if already running)
	context.subscriptions.push(
		vscode.commands.registerCommand("shellular.startBridge", () => {
			vscode.window.showInformationMessage(
				"Shellular CLI Bridge is active and listening for connections.",
			);
		}),
		vscode.commands.registerCommand("shellular.refreshDevices", () => {
			devicesProvider?.refresh();
		}),
		vscode.commands.registerCommand("shellular.clearLogs", () => {
			devicesProvider?.clearLogs();
		}),
	);

	outputChannel.appendLine("[bridge] Shellular CLI Bridge activated");
}

export function deactivate(): void {
	devicesProvider?.setBridgeListening(false);
	devicesProvider?.clear();
	devicesProvider = undefined;
	// Remove lock file
	try {
		fs.unlinkSync(LOCK_PATH);
	} catch {
		// ignore
	}
	// Close server
	server?.close();
	server = undefined;
	// Remove socket file
	try {
		fs.unlinkSync(SOCK_PATH);
	} catch {
		// ignore
	}
}

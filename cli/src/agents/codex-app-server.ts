import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

type JsonRpcId = number;

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

interface JsonRpcResponse {
	id?: JsonRpcId;
	result?: unknown;
	error?: { code?: number; message?: string };
	method?: string;
}

/** Minimal persistent client for Codex's supported app-server JSONL transport. */
export class CodexAppServer {
	private process: ChildProcessWithoutNullStreams | null = null;
	private pending = new Map<JsonRpcId, PendingRequest>();
	private nextId = 1;
	private stdoutBuffer = "";
	private initializeTask: Promise<void> | null = null;

	constructor(private readonly command: string) {}

	async readThread(threadId: string): Promise<unknown> {
		await this.initialize();
		return this.request("thread/read", { threadId, includeTurns: true });
	}

	async warmup(): Promise<void> {
		await this.initialize();
	}

	destroy() {
		this.failPending(new Error("Codex app-server stopped"));
		this.process?.kill();
		this.process = null;
		this.initializeTask = null;
		this.stdoutBuffer = "";
	}

	private initialize() {
		if (!this.initializeTask) {
			this.initializeTask = this.start().catch((error) => {
				this.destroy();
				throw error;
			});
		}
		return this.initializeTask;
	}

	private async start() {
		const child = spawn(this.command, ["app-server", "--stdio"], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.process = child;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.consume(chunk));
		// Drain stderr so a verbose child can never block on a full pipe.
		child.stderr.resume();
		child.on("error", (error) => this.failPending(error));
		child.on("exit", (code, signal) => {
			this.process = null;
			this.initializeTask = null;
			this.failPending(
				new Error(
					`Codex app-server exited (${code ?? "no code"}, ${signal ?? "no signal"})`,
				),
			);
		});

		await this.request("initialize", {
			clientInfo: {
				name: "shellular",
				title: "Shellular",
				version: "1",
			},
			capabilities: {
				experimentalApi: true,
				requestAttestation: false,
			},
		});
		this.notify("initialized", {});
	}

	private request(method: string, params: unknown): Promise<unknown> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Codex app-server request timed out: ${method}`));
			}, 30_000);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.write({ id, method, params });
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private notify(method: string, params: unknown) {
		this.write({ method, params });
	}

	private write(message: unknown) {
		if (!this.process?.stdin.writable) {
			throw new Error("Codex app-server is not running");
		}
		this.process.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private consume(chunk: string) {
		this.stdoutBuffer += chunk;
		let newline = this.stdoutBuffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.stdoutBuffer.slice(0, newline).trim();
			this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
			if (line) this.handleLine(line);
			newline = this.stdoutBuffer.indexOf("\n");
		}
	}

	private handleLine(line: string) {
		let message: JsonRpcResponse;
		try {
			message = JSON.parse(line) as JsonRpcResponse;
		} catch {
			return;
		}
		if (typeof message.id !== "number" || message.method) return;
		const pending = this.pending.get(message.id);
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pending.delete(message.id);
		if (message.error) {
			pending.reject(
				new Error(message.error.message ?? "Codex app-server request failed"),
			);
			return;
		}
		pending.resolve(message.result);
	}

	private failPending(error: Error) {
		for (const request of this.pending.values()) {
			clearTimeout(request.timer);
			request.reject(error);
		}
		this.pending.clear();
	}
}

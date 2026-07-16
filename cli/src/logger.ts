import { format, stripVTControlCharacters } from "node:util";

import type { LocalCliLogEntry } from "@shellular/protocol";

import { config } from "./config";

const MAX_LOG_ENTRIES = 500;

class Logger {
	private paddingLeft: number;
	private static levelsWithTimestamp = new Set(["debug", "warn", "error"]);
	private entries: LocalCliLogEntry[] = [];
	private listeners = new Set<(entry: LocalCliLogEntry) => void>();
	private nextId = 1;

	constructor({ paddingLeft = 2 }: { paddingLeft?: number } = {}) {
		this.paddingLeft = paddingLeft - 1;
	}

	get padding() {
		if (this.paddingLeft <= 0) {
			return "";
		}

		return " ".repeat(this.paddingLeft);
	}

	getEntries(): LocalCliLogEntry[] {
		return [...this.entries];
	}

	subscribe(listener: (entry: LocalCliLogEntry) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	log(...args: unknown[]) {
		this._log("log", args);
	}

	debug(...args: unknown[]) {
		if (!config.SHELLULAR_DEV) {
			return;
		}

		this._log("debug", args);
	}

	warn(...args: unknown[]) {
		this._log("warn", args);
	}

	error(...args: unknown[]) {
		this._log("error", args);
	}

	private _log(level: "log" | "debug" | "warn" | "error", args: unknown[]) {
		const logLevelTag = level === "log" ? "" : `[${level}]`;
		let prefix = logLevelTag ? `${this.padding} ${logLevelTag}` : this.padding;
		if (Logger.levelsWithTimestamp.has(level)) {
			prefix += ` <${new Date().toUTCString()}>`;
		}

		console[level](prefix, ...args);

		const entry: LocalCliLogEntry = {
			id: this.nextId++,
			timestamp: new Date().toISOString(),
			level,
			message: stripVTControlCharacters(format(...args)),
		};
		this.entries.push(entry);
		if (this.entries.length > MAX_LOG_ENTRIES) {
			this.entries.splice(0, this.entries.length - MAX_LOG_ENTRIES);
		}
		for (const listener of this.listeners) listener(entry);
	}
}

export const logger = new Logger({ paddingLeft: 2 });

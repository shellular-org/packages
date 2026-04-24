import { config } from "./config";

class Logger {
	private paddingLeft: number;

	constructor({ paddingLeft = 2 }: { paddingLeft?: number } = {}) {
		this.paddingLeft = paddingLeft - 1;
	}

	get padding() {
		if (this.paddingLeft <= 0) {
			return "";
		}

		return " ".repeat(this.paddingLeft);
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
		const prefix = logLevelTag
			? `${this.padding} ${logLevelTag}`
			: this.padding;
		console[level](prefix, ...args);
	}
}

export const logger = new Logger({ paddingLeft: 2 });

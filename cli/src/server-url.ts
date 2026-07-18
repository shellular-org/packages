export class ServerUrl {
	private url: URL;

	constructor(serverUrl: string) {
		if (serverUrl.startsWith(":")) {
			serverUrl = `http://localhost${serverUrl}`;
		}

		let url: URL;
		try {
			url = new URL(serverUrl);
		} catch {
			throw new Error(`Invalid server URL: ${serverUrl}`);
		}

		if (url.protocol !== "http:" && url.protocol !== "https:") {
			const err = new Error(`Unsupported protocol: ${url.protocol}`);
			err.name = "UnsupportedProtocolError";
			throw err;
		}

		this.url = url;
	}

	toApiUrl({ path }: { path?: string } = {}): string {
		const url = new URL(this.url.toString());
		url.pathname = path || "/";
		return url.toString();
	}

	toWebSocketUrl(): string {
		const url = new URL(this.url.toString());

		if (url.protocol === "http:") {
			url.protocol = "ws:";
		} else if (url.protocol === "https:") {
			url.protocol = "wss:";
		} else {
			throw new Error(`Unsupported protocol: ${url.protocol}`);
		}

		url.pathname = "/cli";
		return url.toString();
	}
}

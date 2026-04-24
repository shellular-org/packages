export class ServerUrl {
	private url: URL;

	constructor(serverUrl: string) {
		if (serverUrl.startsWith(":")) {
			serverUrl = `http://localhost${serverUrl}`;
		} else if (serverUrl.startsWith("ws://")) {
			serverUrl = serverUrl.replace(/^ws:\/\//, "http://");
		} else if (serverUrl.startsWith("wss://")) {
			serverUrl = serverUrl.replace(/^wss:\/\//, "https://");
		} else if (
			!serverUrl.startsWith("http://") &&
			!serverUrl.startsWith("https://")
		) {
			serverUrl = `http://${serverUrl}`;
		}

		try {
			this.url = new URL(serverUrl);
		} catch {
			throw new Error(`Invalid server URL: ${serverUrl}`);
		}
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

import type { ClientInfo } from "@shellular/protocol";

export class ConnectedClients {
	private connectedClients: Map<string, ClientInfo>;

	constructor() {
		this.connectedClients = new Map<string, ClientInfo>();
	}

	add(clientId: string, clientInfo: ClientInfo): void {
		this.connectedClients.set(clientId, clientInfo);
	}

	delete(clientId: string): void {
		this.connectedClients.delete(clientId);
	}

	isConnected(clientId: string): boolean {
		return this.connectedClients.has(clientId);
	}

	getAll(): string[] {
		return Array.from(this.connectedClients.keys());
	}

	removeAll(): void {
		this.connectedClients.clear();
	}
}

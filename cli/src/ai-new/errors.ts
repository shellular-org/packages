export class AiNewError extends Error {
	constructor(
		message: string,
		readonly code: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "AiNewError";
	}
}

export class UnsupportedCapabilityError extends AiNewError {
	constructor(agentId: string, capability: string) {
		super(
			`Agent "${agentId}" does not support ${capability}`,
			"EUNSUPPORTED_CAPABILITY",
			{ agentId, capability },
		);
	}
}

export class AgentUnavailableError extends AiNewError {
	constructor(agentId: string, reason?: string) {
		super(
			`Agent "${agentId}" is not available${reason ? `: ${reason}` : ""}`,
			"EAGENT_UNAVAILABLE",
			{ agentId, reason },
		);
	}
}

export class PermissionNotFoundError extends AiNewError {
	constructor(permissionId: string) {
		super(`Permission request "${permissionId}" was not found`, "EPERM_NOT_FOUND", {
			permissionId,
		});
	}
}

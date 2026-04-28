import { BUILTIN_AGENT_DESCRIPTORS } from "./agents";
import { ACP } from "./base";

const descriptor = BUILTIN_AGENT_DESCRIPTORS.find(
	(agent) => agent.id === "claude-code",
);

export class ClaudeCode extends ACP {
	static create() {
		if (!descriptor) return null;
		return new ClaudeCode(descriptor);
	}
}

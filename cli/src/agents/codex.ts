import { BUILTIN_AGENT_DESCRIPTORS } from "./agents";
import { ACP } from "./base";

const descriptor = BUILTIN_AGENT_DESCRIPTORS.find(
	(agent) => agent.id === "codex",
);

export class Codex extends ACP {
	static create() {
		if (!descriptor) return null;
		return new Codex(descriptor);
	}
}

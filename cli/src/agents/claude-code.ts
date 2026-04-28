import { BUILTIN_AGENT_DESCRIPTORS } from "./agents";
import { ACP } from "./base";

export class ClaudeCode extends ACP {
	static create() {
		return new ClaudeCode(BUILTIN_AGENT_DESCRIPTORS["claude-code"]);
	}
}

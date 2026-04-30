import { BUILTIN_AGENT_DESCRIPTORS } from "./agents";
import { ACP } from "./base";

export class Copilot extends ACP {
	static create() {
		return new Copilot(BUILTIN_AGENT_DESCRIPTORS.copilot);
	}
}

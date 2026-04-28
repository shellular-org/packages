import { BUILTIN_AGENT_DESCRIPTORS } from "./agents";
import { ACP } from "./base";

export class Codex extends ACP {
	static create() {
		return new Codex(BUILTIN_AGENT_DESCRIPTORS.codex);
	}
}

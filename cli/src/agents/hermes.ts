import { BUILTIN_AGENT_DESCRIPTORS } from "./agents";
import { ACP } from "./base";

export class Hermes extends ACP {
	static create() {
		return new Hermes(BUILTIN_AGENT_DESCRIPTORS["hermes"]);
	}
}

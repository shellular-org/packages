import { BUILTIN_AGENT_DESCRIPTORS } from "./agents";
import { ACP } from "./base";

export class Fx extends ACP {
	static create() {
		return new Fx(BUILTIN_AGENT_DESCRIPTORS.fx);
	}
}

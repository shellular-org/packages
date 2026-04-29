import { BUILTIN_AGENT_DESCRIPTORS } from "./agents";
import { ACP } from "./base";

export class Pi extends ACP {
	static create() {
		return new Pi(BUILTIN_AGENT_DESCRIPTORS.pi);
	}
}

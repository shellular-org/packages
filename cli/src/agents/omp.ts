import { BUILTIN_AGENT_DESCRIPTORS } from "./agents";
import { ACP } from "./base";

/** Oh My Pi ACP runtime. */
export class Omp extends ACP {
	static create() {
		return new Omp(BUILTIN_AGENT_DESCRIPTORS.omp);
	}
}

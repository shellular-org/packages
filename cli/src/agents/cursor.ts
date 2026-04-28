import { BUILTIN_AGENT_DESCRIPTORS } from "./agents";
import { ACP } from "./base";

const descriptor = BUILTIN_AGENT_DESCRIPTORS.find(
	(agent) => agent.id === "cursor",
);

/**
 * ACP client for Cursor CLI.
 *
 * Cursor exposes ACP via `cursor agent acp`.
 * See: https://cursor.com/docs/cli/acp
 */
export class Cursor extends ACP {
	static create() {
		if (!descriptor) return null;
		return new Cursor(descriptor);
	}
}

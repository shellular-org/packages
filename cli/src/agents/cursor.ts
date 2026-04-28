import { BUILTIN_AGENT_DESCRIPTORS } from "./agents";
import { ACP } from "./base";

/**
 * ACP client for Cursor CLI.
 *
 * Cursor exposes ACP via `cursor agent acp`.
 * See: https://cursor.com/docs/cli/acp
 */
export class Cursor extends ACP {
	static create() {
		return new Cursor(BUILTIN_AGENT_DESCRIPTORS.cursor);
	}
}

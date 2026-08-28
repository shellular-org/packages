import { BUILTIN_AGENT_DESCRIPTORS } from "./agents";
import { ACP } from "./base";

/**
 * Claude Code records an `entrypoint` on every transcript record, and both of
 * its resume pickers hide the ones that look machine-driven: `/resume` in the
 * CLI and the session list in the VS Code extension each drop `sdk-cli`,
 * `sdk-ts` and `sdk-py`. The Agent SDK that the ACP adapter runs on stamps
 * `sdk-ts` unless the variable is already set, so a session started from the
 * phone lands in ~/.claude/projects like any other and is then invisible at
 * the desk, which is exactly where you want to pick it up.
 *
 * Any value outside that filtered set fixes it, with one exception: `cli` is
 * rewritten to `sdk-cli` when Claude Code runs under the SDK, and is filtered
 * again.
 */
const DEFAULT_ENTRYPOINT = "shellular";

export class ClaudeCode extends ACP {
	static create() {
		return new ClaudeCode(BUILTIN_AGENT_DESCRIPTORS["claude-code"]);
	}

	/**
	 * Only when the operator has not set one themselves, the way the SDK does
	 * it. Baking it into the descriptor would win over an inherited value,
	 * since `spawnAgentProcess` merges the descriptor env over `process.env`.
	 */
	protected override spawnEnvOverride(): Record<string, string> | undefined {
		if (process.env.CLAUDE_CODE_ENTRYPOINT) return undefined;
		return { CLAUDE_CODE_ENTRYPOINT: DEFAULT_ENTRYPOINT };
	}
}

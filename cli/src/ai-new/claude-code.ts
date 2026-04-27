import { npxCommand } from "@/config";
import { ACP, type AgentProcessConfig } from "./base";

const ACP_CLAUDE_CODE: AgentProcessConfig = {
	name: "claude-code",
	agentExecutable: "claude",
	command: npxCommand,
	args: ["-yes", "@agentclientprotocol/claude-agent-acp"],
};

/** ACP client for the Claude Code agent (via `@agentclientprotocol/claude-agent-acp`). */
export class ClaudeCode extends ACP {
	/** Spawns the Claude Code agent and returns a ready-to-init instance, or `null` claude code is unavailable. */
	static create() {
		const spawned = ACP.spawnAgentProcess(ACP_CLAUDE_CODE);
		if (!spawned) {
			return null;
		}

		return new ClaudeCode(spawned);
	}
}

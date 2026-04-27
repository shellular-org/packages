import { npxCommand } from "@/config";
import { ACP, type AgentProcessConfig } from "./base";

const ACP_CODEX: AgentProcessConfig = {
	name: "codex",
	agentExecutable: "codex",
	command: npxCommand,
	args: ["-yes", "@zed-industries/codex-acp"],
};

/** ACP client for the Codex agent (via `@zed-industries/codex-acp`). */
export class Codex extends ACP {
	/** Spawns the Codex agent and returns a ready-to-init instance, or `null` if npx is unavailable. */
	static create() {
		const spawned = ACP.spawnAgentProcess(ACP_CODEX);
		if (!spawned) {
			return null;
		}

		return new Codex(spawned);
	}
}

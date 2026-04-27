import { type AiBackend, MsgType } from "@shellular/protocol";

import type { Connection } from "@/connection";
import { logger } from "@/logger";
import { ClaudeCode } from "./claude-code";
import { Codex } from "./codex";
import { OpenCode } from "./opencode";

type AgentClass = typeof Codex | typeof OpenCode | typeof ClaudeCode;
type Agent = InstanceType<AgentClass>;

export class AgentsManager {
	static agentClassMapping: Record<
		Extract<AiBackend, "codex" | "opencode" | "claude-code">,
		AgentClass
	> = {
		codex: Codex,
		opencode: OpenCode,
		"claude-code": ClaudeCode,
	};

	agents: Map<AiBackend, Agent>;

	constructor() {
		this.agents = new Map<AiBackend, Agent>();
		for (const [agent, AgentClass] of Object.entries(
			AgentsManager.agentClassMapping,
		)) {
			const instance = AgentClass.create();
			if (instance) {
				this.agents.set(agent as AiBackend, instance);
			} else {
				logger.debug(`${agent} is not available`);
			}
		}
	}

	destroy() {
		for (const agent of this.agents.values()) {
			agent.destroy();
		}
		this.agents.clear();
	}

	getAvailableAgents(): AiBackend[] {
		return Array.from(this.agents.keys());
	}

	handleConnection(conn: Connection) {
		conn.on(MsgType.AI_AVAILABILITY, (msg) => {
			conn.send({
				type: MsgType.AI_AVAILABILITY_RESULT,
				clientId: msg.clientId,
				respTo: msg.id,
				data: { backends: this.getAvailableAgents() },
			});
		});
	}
}

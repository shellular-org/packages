import { type AiBackend, MsgType } from "@shellular/protocol";

import type { Connection } from "@/connection";

import { Codex } from "./codex";
import { OpenCode } from "./opencode";

export async function initAiHandler(conn: Connection) {
	const agents = {
		codex: Codex.create(),
		opencode: OpenCode.create(),
		"claude-code": null,
		copilot: null,
	} satisfies Record<AiBackend, unknown>;

	const available = new Set<AiBackend>();
	for (const [agent, instance] of Object.entries(agents)) {
		if (instance) {
			available.add(agent as AiBackend);
		}
	}

	conn.on(MsgType.AI_AVAILABILITY, (msg) => {
		conn.send({
			type: MsgType.AI_AVAILABILITY_RESULT,
			clientId: msg.clientId,
			respTo: msg.id,
			data: { backends: [...available] },
		});
	});
}

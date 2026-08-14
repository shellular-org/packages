import type * as acp from "@agentclientprotocol/sdk";
import type { AiSessionOwner } from "@shellular/protocol";

import { BUILTIN_AGENT_DESCRIPTORS } from "./agents";
import { ACP } from "./base";
import {
	codexThreadToSessionUpdates,
	isCodexActiveWriterError,
	readCodexThread,
} from "./codex-readonly";
import { SessionOwnedByProcessError } from "./errors";
import type { AcpTranscriptOptions } from "./events";
import { findAgentProcesses } from "./process-scanner";
import { normalizeCodexUserReplayMessage } from "./replay-normalization";

export class Codex extends ACP {
	static create() {
		return new Codex(BUILTIN_AGENT_DESCRIPTORS.codex);
	}

	protected override transcriptOptions(): AcpTranscriptOptions {
		return {
			normalizeUserReplayMessage: normalizeCodexUserReplayMessage,
		};
	}

	protected override async loadSessionFallback(
		params: acp.LoadSessionRequest,
		error: unknown,
	) {
		if (!isCodexActiveWriterError(error)) return null;

		const thread = await readCodexThread(
			this.descriptor.agentExecutable,
			params.sessionId,
			params.cwd,
		);

		return {
			response: { configOptions: [] },
			updates: codexThreadToSessionUpdates(params.sessionId, thread),
			requiresResume: true,
		};
	}

	override async resumeSession(params: acp.ResumeSessionRequest) {
		try {
			return await super.resumeSession(params);
		} catch (error) {
			if (!isCodexActiveWriterError(error)) throw error;

			const owner = await this.findOwner(params.cwd);
			throw new SessionOwnedByProcessError(params.sessionId, params.cwd, owner);
		}
	}

	private async findOwner(cwd: string): Promise<AiSessionOwner | undefined> {
		const process = (await findAgentProcesses("codex", cwd))[0];
		if (!process) return undefined;
		return {
			pid: process.pid,
			command: process.command,
			cwd: process.cwd,
			...(process.startedAt > 0 ? { startedAt: process.startedAt } : {}),
		};
	}
}

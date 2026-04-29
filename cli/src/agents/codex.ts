import { BUILTIN_AGENT_DESCRIPTORS } from "./agents";
import { ACP } from "./base";
import type { AcpTranscriptOptions } from "./events";
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
}

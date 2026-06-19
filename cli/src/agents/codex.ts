import { BUILTIN_AGENT_DESCRIPTORS } from "./agents";
import { ACP } from "./base";
import { CodexAppServer } from "./codex-app-server";
import type { AcpTranscriptOptions } from "./events";
import { normalizeCodexHistory } from "./native-history";
import { normalizeCodexUserReplayMessage } from "./replay-normalization";

export class Codex extends ACP {
	private readonly appServer = new CodexAppServer("codex");

	static create() {
		return new Codex(BUILTIN_AGENT_DESCRIPTORS.codex);
	}

	protected override transcriptOptions(): AcpTranscriptOptions {
		return {
			normalizeUserReplayMessage: normalizeCodexUserReplayMessage,
		};
	}

	override hasNativeSessionHistory(): boolean {
		return true;
	}

	override async readNativeSessionHistory(params: { sessionId: string }) {
		const result = await this.appServer.readThread(params.sessionId);
		return { messages: normalizeCodexHistory(result) };
	}

	override destroy() {
		this.appServer.destroy();
		super.destroy();
	}
}

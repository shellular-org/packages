import { BUILTIN_AGENT_DESCRIPTORS } from "./agents";
import { ACP } from "./base";
import { CodexAppServer } from "./codex-app-server";
import type { AcpTranscriptOptions } from "./events";
import { normalizeCodexHistoryPage } from "./native-history";
import { normalizeCodexUserReplayMessage } from "./replay-normalization";
import type { NativeSessionHistoryRequest } from "./types";

const NATIVE_HISTORY_PAGE_SIZE = 30;

export class Codex extends ACP {
	private static readonly appServer = new CodexAppServer("codex");
	private readonly nativeHistory = new Map<string, unknown>();

	static destroyNativeHistoryRuntime() {
		Codex.appServer.destroy();
	}

	static warmNativeHistoryRuntime() {
		return Codex.appServer.warmup();
	}

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

	override async readNativeSessionHistory(params: NativeSessionHistoryRequest) {
		let history = this.nativeHistory.get(params.sessionId);
		if (!params.cursor || !history) {
			history = await Codex.appServer.readThread(params.sessionId);
			this.nativeHistory.set(params.sessionId, history);
		}
		const limit = params.limit ?? NATIVE_HISTORY_PAGE_SIZE;
		return {
			messages: normalizeCodexHistoryPage(history, params.cursor, limit),
		};
	}

	override destroy() {
		this.nativeHistory.clear();
		super.destroy();
	}
}

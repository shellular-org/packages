import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";

import { BUILTIN_AGENT_DESCRIPTORS } from "./agents";
import { ACP } from "./base";
import { normalizeClaudeCodeHistory } from "./native-history";
import type { NativeSessionHistoryRequest } from "./types";

const NATIVE_HISTORY_PAGE_SIZE = 30;

export class ClaudeCode extends ACP {
	static create() {
		return new ClaudeCode(BUILTIN_AGENT_DESCRIPTORS["claude-code"]);
	}

	override hasNativeSessionHistory(): boolean {
		return true;
	}

	override async readNativeSessionHistory(params: NativeSessionHistoryRequest) {
		const all = await getSessionMessages(params.sessionId, {
			...(params.cwd ? { dir: params.cwd } : {}),
		});
		const history = normalizeClaudeCodeHistory(all);
		const limit = params.limit ?? NATIVE_HISTORY_PAGE_SIZE;
		let page = history;
		if (params.cursor) {
			const cursorIndex = history.findIndex(
				(message) => message.id === params.cursor,
			);
			if (cursorIndex < 0) return { messages: [] };
			page = history.slice(0, cursorIndex);
		}
		return { messages: page.slice(-limit) };
	}
}

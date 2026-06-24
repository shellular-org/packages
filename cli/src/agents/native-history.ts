import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Message, Part } from "@opencode-ai/sdk/v2";
import type { AcpMessage, AcpMessagePart } from "@shellular/protocol";

type OpenCodeEntry = { info: Message; parts: Part[] };

type ClaudeContentBlock = Record<string, unknown> & { type?: string };

type ClaudeToolCallPart = {
	id?: string;
	type: "tool_call";
	name: string;
	title?: string;
	arguments?: string;
	status?: string;
	output?: string;
	parts?: unknown[];
};

/**
 * Normalize Claude Code session messages (from `getSessionMessages`) into the
 * ACP message shape. User entries whose content is purely `tool_result` blocks
 * are folded back into the preceding assistant's `tool_call` parts rather than
 * being rendered as standalone user turns. Subagent (`parent_tool_use_id != null`)
 * entries are dropped from the main transcript to match the codex subtask
 * treatment.
 */
export function normalizeClaudeCodeHistory(
	entries: SessionMessage[],
): AcpMessage[] {
	const messages: AcpMessage[] = [];
	const pendingToolCalls = new Map<string, ClaudeToolCallPart>();
	for (const entry of entries) {
		if (entry.parent_tool_use_id) continue;
		const content = (entry.message as { content?: unknown }).content;
		const blocks = Array.isArray(content)
			? (content as ClaudeContentBlock[])
			: null;
		if (!blocks) {
			const text = typeof content === "string" ? content : undefined;
			if (!text) continue;
			maybeMerge(messages, "user", entry.uuid, [{ type: "text", text }]);
			continue;
		}
		const parts: AcpMessagePart[] = [];
		let onlyToolResults = true;
		for (const block of blocks) {
			const part = claudeBlockPart(block, pendingToolCalls);
			if (part) {
				parts.push(part);
				if (block.type !== "tool_result") onlyToolResults = false;
			}
		}
		if (entry.type === "user" && onlyToolResults) continue;
		if (!parts.length) continue;
		maybeMerge(messages, entry.type, entry.uuid, parts);
	}
	return messages;
}

function maybeMerge(
	target: AcpMessage[],
	role: "user" | "assistant" | string,
	id: string,
	parts: AcpMessagePart[],
) {
	const previous = target[target.length - 1];
	if (previous && previous.role === role) {
		appendNormalizedParts(previous.parts, parts);
		return;
	}
	target.push({ id, role: role as "user" | "assistant", parts });
}

function claudeBlockPart(
	block: ClaudeContentBlock,
	pending: Map<string, ClaudeToolCallPart>,
): AcpMessagePart | null {
	switch (block.type) {
		case "text":
			return typeof block.text === "string"
				? { type: "text", text: block.text }
				: null;
		case "thinking":
			return typeof block.thinking === "string"
				? { type: "reasoning", content: block.thinking, summary: "Reasoning" }
				: null;
		case "tool_use": {
			const id = typeof block.id === "string" ? block.id : undefined;
			const name = typeof block.name === "string" ? block.name : "tool";
			const part: ClaudeToolCallPart = {
				id,
				type: "tool_call",
				name: inferClaudeToolKind(name),
				title: name,
				arguments: json(block.input),
				status: "in_progress",
			};
			if (id) pending.set(id, part);
			return part;
		}
		case "tool_result": {
			const id =
				typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
			const existing = id ? pending.get(id) : undefined;
			const output = claudeToolResultOutput(block.content);
			const failed = typeof block.is_error === "boolean" && block.is_error;
			if (existing) {
				existing.output = output ?? existing.output;
				if (failed) {
					existing.status = "failed";
				} else if (existing.status === "in_progress") {
					existing.status = "completed";
				}
				if (id) pending.delete(id);
				return null;
			}
			return {
				id,
				type: "tool_call",
				name: "other",
				title: "Tool result",
				output,
				status: failed ? "failed" : "completed",
			};
		}
		case "image":
			return typeof block.source === "object" && block.source
				? {
						type: "image",
						src: claudeImageSrc(block.source as Record<string, unknown>),
						alt: "Image",
						mime:
							typeof (block.source as Record<string, unknown>).media_type ===
							"string"
								? ((block.source as Record<string, unknown>)
										.media_type as string)
								: "image/png",
					}
				: null;
		default:
			return null;
	}
}

function claudeToolResultOutput(content: unknown): string | undefined {
	if (typeof content === "string") return content || undefined;
	if (!Array.isArray(content)) return content ? json(content) : undefined;
	return (
		content
			.flatMap((block): string[] => {
				if (!block || typeof block !== "object") return [];
				const value = block as Record<string, unknown>;
				if (value.type === "text" && typeof value.text === "string")
					return [value.text];
				if (value.type === "image") return ["[image]"];
				return [];
			})
			.join("\n") || undefined
	);
}

function claudeImageSrc(source: Record<string, unknown>): string {
	if (typeof source.data === "string") {
		const media =
			typeof source.media_type === "string" ? source.media_type : "image/png";
		return `data:${media};base64,${source.data}`;
	}
	if (typeof source.url === "string") return source.url;
	return "";
}

function inferClaudeToolKind(name: string): string {
	const normalized = name.toLowerCase();
	if (/read|notebookread|view|goto/.test(normalized)) return "read";
	if (/write|edit|update|patch|apply|notebookedit|multiedit/.test(normalized))
		return "edit";
	if (/grep|glob|search|find|list|nearest/.test(normalized)) return "search";
	if (/bash|shell|exec|command|run/.test(normalized)) return "execute";
	return "other";
}

interface CodexThreadReadResult {
	thread?: {
		turns?: Array<{
			id: string;
			startedAt?: number | null;
			items?: Array<Record<string, unknown> & { id?: string; type?: string }>;
		}>;
	};
}

export function normalizeOpenCodeHistory(
	entries: OpenCodeEntry[],
): AcpMessage[] {
	const messages: AcpMessage[] = [];
	for (const { info, parts } of entries) {
		const normalizedParts = parts.flatMap(openCodePart);
		const previous = messages[messages.length - 1];
		if (previous?.role === info.role) {
			appendNormalizedParts(previous.parts, normalizedParts);
			continue;
		}
		messages.push({
			id: info.id,
			role: info.role,
			timestamp: info.time.created,
			parts: normalizedParts,
		});
	}
	return messages;
}

export function normalizeCodexHistory(result: unknown): AcpMessage[] {
	const thread = (result as CodexThreadReadResult | null)?.thread;
	if (!thread?.turns)
		throw new Error("Codex app-server returned no thread history");
	return thread.turns.flatMap(normalizeCodexTurn);
}

export function normalizeCodexHistoryPage(
	result: unknown,
	before: string | undefined,
	limit: number,
): AcpMessage[] {
	const thread = (result as CodexThreadReadResult | null)?.thread;
	if (!thread?.turns)
		throw new Error("Codex app-server returned no thread history");
	const page: AcpMessage[] = [];
	let foundCursor = before === undefined;
	for (let index = thread.turns.length - 1; index >= 0; index -= 1) {
		let turnMessages = normalizeCodexTurn(thread.turns[index]);
		if (!foundCursor) {
			const cursorIndex = turnMessages.findIndex(
				(message) => message.id === before,
			);
			if (cursorIndex < 0) continue;
			foundCursor = true;
			turnMessages = turnMessages.slice(0, cursorIndex);
		}
		if (turnMessages.length > 0) page.unshift(...turnMessages);
		if (page.length >= limit) return page.slice(-limit);
	}
	return foundCursor ? page : [];
}

function normalizeCodexTurn(
	turn: NonNullable<
		NonNullable<CodexThreadReadResult["thread"]>["turns"]
	>[number],
): AcpMessage[] {
	const messages: AcpMessage[] = [];
	let assistant: AcpMessage | null = null;
	for (const item of turn.items ?? []) {
		if (item.type === "userMessage") {
			assistant = null;
			messages.push({
				id: item.id ?? `${turn.id}:user`,
				role: "user",
				timestamp: secondsToMs(turn.startedAt),
				parts: codexUserParts(item.content),
			});
			continue;
		}
		const parts = codexAssistantParts(item);
		if (!parts.length) continue;
		if (!assistant) {
			assistant = {
				id: `${turn.id}:assistant`,
				role: "assistant",
				timestamp: secondsToMs(turn.startedAt),
				parts: [],
			};
			messages.push(assistant);
		}
		appendNormalizedParts(assistant.parts, parts);
	}
	return messages;
}

function openCodePart(part: Part): AcpMessagePart[] {
	switch (part.type) {
		case "text":
			return part.ignored ? [] : [{ type: "text", text: part.text }];
		case "reasoning":
			return [{ type: "reasoning", content: part.text, summary: "Reasoning" }];
		case "file": {
			if (part.mime.startsWith("image/")) {
				return [
					{
						id: part.id,
						type: "image",
						src: part.url,
						alt: part.filename,
						mime: part.mime,
					},
				];
			}
			const path =
				part.source?.type === "file" || part.source?.type === "symbol"
					? part.source.path
					: part.url.replace(/^file:\/\//, "");
			return part.url.startsWith("http")
				? [
						{
							id: part.id,
							type: "web_reference",
							url: part.url,
							title: part.filename,
						},
					]
				: [{ id: part.id, type: "file_reference", path }];
		}
		case "tool": {
			const output =
				part.state.status === "completed"
					? part.state.output
					: part.state.status === "error"
						? part.state.error
						: undefined;
			return [
				{
					id: part.callID || part.id,
					type: "tool_call",
					name: inferOpenCodeToolKind(part.tool),
					title:
						("title" in part.state ? part.state.title : undefined) ?? part.tool,
					arguments: JSON.stringify(part.state.input, null, 2),
					output,
					status: normalizeToolStatus(part.state.status),
					parts:
						"attachments" in part.state
							? part.state.attachments?.flatMap(openCodePart)
							: undefined,
				},
			];
		}
		case "subtask":
			return [
				{
					id: part.id,
					type: "tool_call",
					name: "subtask",
					title: part.description,
					arguments: part.prompt,
					status: "completed",
				},
			];
		default:
			return [];
	}
}

function codexUserParts(value: unknown): AcpMessagePart[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((input): AcpMessagePart[] => {
		if (!input || typeof input !== "object") return [];
		const item = input as Record<string, unknown>;
		switch (item.type) {
			case "text":
				return typeof item.text === "string"
					? [{ type: "text", text: item.text }]
					: [];
			case "image":
				return typeof item.url === "string"
					? [{ type: "image", src: item.url, alt: "Image" }]
					: [];
			case "localImage":
			case "skill":
			case "mention":
				return typeof item.path === "string"
					? [{ type: "file_reference", path: item.path }]
					: [];
			default:
				return [];
		}
	});
}

function codexAssistantParts(
	item: Record<string, unknown> & { id?: string; type?: string },
): AcpMessagePart[] {
	switch (item.type) {
		case "agentMessage":
			return typeof item.text === "string"
				? [{ type: "text", text: item.text }]
				: [];
		case "reasoning": {
			const summary = stringArray(item.summary).join("\n");
			const content = stringArray(item.content).join("\n") || summary;
			return content
				? [{ type: "reasoning", content, summary: summary || "Reasoning" }]
				: [];
		}
		case "plan":
			return typeof item.text === "string"
				? [{ type: "plan", content: item.text, summary: "Plan" }]
				: [];
		case "commandExecution":
			return typeof item.command === "string"
				? [
						{
							id: item.id,
							type: "tool_call",
							name: inferCommandKind(item.command),
							title: formatCommandTitle(item.command),
							arguments: json({
								command: item.command,
								cwd: typeof item.cwd === "string" ? item.cwd : undefined,
							}),
							output:
								typeof item.aggregatedOutput === "string"
									? item.aggregatedOutput
									: undefined,
							status: normalizeToolStatus(item.status),
						},
					]
				: [];
		case "fileChange": {
			const changes = Array.isArray(item.changes) ? item.changes : [];
			const paths = changes.flatMap((change) =>
				change &&
				typeof change === "object" &&
				typeof (change as Record<string, unknown>).path === "string"
					? [(change as Record<string, unknown>).path as string]
					: [],
			);
			return [
				{
					id: item.id,
					type: "tool_call",
					name: "edit",
					title: paths.length ? `Edit ${paths.join(", ")}` : "Edit",
					arguments: json({ changes: paths }),
					status: normalizeToolStatus(item.status),
					parts: changes.flatMap(codexFileChange),
				},
			];
		}
		case "mcpToolCall":
			return [
				{
					id: item.id,
					type: "tool_call",
					name: "other",
					title: `Tool: ${String(item.server ?? "mcp")}/${String(item.tool ?? "tool")}`,
					arguments: json(item.arguments ?? item.prompt),
					output: json(item.result ?? item.contentItems ?? item.error),
					status: normalizeToolStatus(item.status),
				},
			];
		case "dynamicToolCall":
		case "collabAgentToolCall":
			return [
				{
					id: item.id,
					type: "tool_call",
					name: "other",
					title: `Tool: ${String(item.tool ?? item.type)}`,
					arguments: json(item.arguments ?? item.prompt),
					output: json(item.result ?? item.contentItems ?? item.error),
					status: normalizeToolStatus(item.status),
				},
			];
		case "webSearch":
			return typeof item.query === "string"
				? [
						{
							id: item.id,
							type: "tool_call",
							name: "search",
							title: item.query,
							arguments: item.query,
							status: "completed",
						},
					]
				: [];
		case "imageView":
			return typeof item.path === "string"
				? [
						{
							id: item.id,
							type: "tool_call",
							name: "read",
							title: `View ${item.path}`,
							status: "completed",
							parts: [{ type: "file_reference", path: item.path }],
						},
					]
				: [];
		case "imageGeneration":
			return [
				{
					id: item.id,
					type: "tool_call",
					name: "other",
					title: "Image generation",
					status: normalizeToolStatus(item.status),
					parts: codexImageGenerationParts(item),
				},
			];
		default:
			return [];
	}
}

function codexFileChange(change: unknown): AcpMessagePart[] {
	if (!change || typeof change !== "object") return [];
	const value = change as Record<string, unknown>;
	if (typeof value.path !== "string") return [];
	const diffs =
		typeof value.diff === "string"
			? unifiedDiffParts(value.path, value.diff)
			: [];
	return diffs.length
		? diffs
		: [
				{
					type: "file_change",
					path: value.path,
					kind: typeof value.kind === "string" ? value.kind : "update",
					status: "completed",
				},
			];
}

function unifiedDiffParts(path: string, diff: string): AcpMessagePart[] {
	const parts: AcpMessagePart[] = [];
	let oldText = "";
	let newText = "";
	let inHunk = false;
	const flush = () => {
		if (!inHunk) return;
		parts.push({
			type: "file_change",
			path,
			kind: "update",
			diff: { old: oldText, new: newText },
			status: "completed",
		});
		oldText = "";
		newText = "";
	};
	for (const line of diff.split(/(?<=\n)/)) {
		if (line.startsWith("@@")) {
			flush();
			inHunk = true;
			continue;
		}
		if (!inHunk || line.startsWith("\\ No newline")) continue;
		if (line.startsWith("-")) oldText += line.slice(1);
		else if (line.startsWith("+")) newText += line.slice(1);
		else if (line.startsWith(" ")) {
			oldText += line.slice(1);
			newText += line.slice(1);
		}
	}
	flush();
	return parts;
}

function codexImageGenerationParts(
	item: Record<string, unknown>,
): AcpMessagePart[] {
	const parts: AcpMessagePart[] = [];
	if (typeof item.revisedPrompt === "string" && item.revisedPrompt) {
		parts.push({ type: "text", text: `Revised prompt: ${item.revisedPrompt}` });
	}
	if (typeof item.result === "string" && item.result) {
		parts.push({
			type: "image",
			src: item.result.startsWith("data:")
				? item.result
				: `data:image/png;base64,${item.result}`,
			alt: "Generated image",
			mime: "image/png",
		});
	}
	return parts;
}

function appendNormalizedParts(
	target: AcpMessagePart[],
	parts: AcpMessagePart[],
) {
	for (const part of parts) {
		const previous = target[target.length - 1];
		if (part.type === "text" && previous?.type === "text") {
			previous.text += part.text;
		} else if (part.type === "reasoning" && previous?.type === "reasoning") {
			previous.content += part.content;
		} else {
			target.push(part);
		}
	}
}

function inferOpenCodeToolKind(tool: string) {
	const normalized = tool.toLowerCase();
	if (/read|view/.test(normalized)) return "read";
	if (/write|edit|patch|apply/.test(normalized)) return "edit";
	if (/grep|glob|search|find|list/.test(normalized)) return "search";
	if (/bash|shell|exec|command/.test(normalized)) return "execute";
	return "other";
}

function inferCommandKind(command: string) {
	const normalized = command.trim().toLowerCase();
	if (/^(cat|sed|head|tail|less|bat)\b/.test(normalized)) return "read";
	if (/^(rg|grep|find|fd|ls)\b/.test(normalized)) return "search";
	return "execute";
}

function formatCommandTitle(command: string) {
	const normalized = command.trim().replace(/\s+/g, " ");
	return normalized.length > 120
		? `${normalized.slice(0, 117)}...`
		: normalized;
}

function normalizeToolStatus(value: unknown) {
	switch (value) {
		case "running":
		case "inProgress":
		case "in_progress":
			return "in_progress";
		case "error":
		case "failed":
		case "declined":
			return "failed";
		case "pending":
			return "pending";
		default:
			return "completed";
	}
}

function stringArray(value: unknown) {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function secondsToMs(value: number | null | undefined) {
	return typeof value === "number" ? value * 1000 : undefined;
}

function json(value: unknown) {
	if (value === undefined || value === null) return undefined;
	return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

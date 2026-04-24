interface CacheCreation {
	ephemeral_1h_input_tokens: number;
	ephemeral_5m_input_tokens: number;
}

interface Iteration {
	input_tokens: number;
	output_tokens: number;
	cache_read_input_tokens: number;
	cache_creation_input_tokens: number;
	cache_creation: CacheCreation;
	type: "message";
}

interface ServerToolUse {
	web_search_requests: number;
	web_fetch_requests: number;
}

interface Usage {
	input_tokens: number;
	cache_creation_input_tokens: number;
	cache_read_input_tokens: number;
	output_tokens: number;
	server_tool_use: ServerToolUse;
	service_tier: string;
	cache_creation: CacheCreation;
	inference_geo: string;
	iterations: Iteration[];
	speed: string;
}

interface ThinkingBlock {
	type: "thinking";
	thinking: string;
	signature: string;
}

interface TextBlock {
	type: "text";
	text: string;
}

interface ToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: Record<string, unknown>;
	caller: { type: string };
}

interface ToolResultContent {
	type: "text";
	text: string;
}

interface ToolResultBlock {
	tool_use_id: string;
	type: "tool_result";
	content: string | ToolResultContent[];
	is_error?: boolean;
}

export type ClaudeAssistantContentBlock =
	| ThinkingBlock
	| TextBlock
	| ToolUseBlock
	| ToolResultBlock;

export interface ClaudeUserMessage {
	role: "user";
	content: string | ToolResultBlock[];
}

export interface ClaudeAssistantMessage {
	model: string;
	id: string;
	type: "message";
	role: "assistant";
	content: ClaudeAssistantContentBlock[];
	stop_reason: string | null;
	stop_sequence: string | null;
	stop_details: unknown | null;
	usage: Usage;
}

interface BaseEntry {
	uuid: string;
	session_id: string;
	parent_tool_use_id: string | null;
	timestamp: string;
}

export interface ClaudeUserEntry extends BaseEntry {
	type: "user";
	message: ClaudeUserMessage;
}

export interface ClaudeAssistantEntry extends BaseEntry {
	type: "assistant";
	message: ClaudeAssistantMessage;
}

export type ClaudeSessionEntry = ClaudeUserEntry | ClaudeAssistantEntry;

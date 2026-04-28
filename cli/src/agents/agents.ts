import { npxCommand } from "@/config";
import { commandExists } from "@/utils";
import type { AgentDescriptor, AgentInfo } from "./types";

export const BUILTIN_AGENT_DESCRIPTORS: AgentDescriptor[] = [
	{
		id: "codex",
		backend: "codex",
		name: "Codex",
		title: "Codex",
		source: "builtin",
		agentExecutable: "codex",
		spawn: {
			command: npxCommand,
			args: ["-yes", "@zed-industries/codex-acp"],
		},
	},
	{
		id: "opencode",
		backend: "opencode",
		name: "OpenCode",
		title: "OpenCode",
		source: "builtin",
		agentExecutable: "opencode",
		spawn: {
			command: "opencode",
			args: ["acp"],
		},
	},
	{
		id: "claude-code",
		backend: "claude-code",
		name: "Claude Code",
		title: "Claude Code",
		source: "builtin",
		agentExecutable: "claude",
		spawn: {
			command: npxCommand,
			args: ["-yes", "@agentclientprotocol/claude-agent-acp"],
		},
	},
	{
		id: "cursor",
		backend: "cursor",
		name: "Cursor",
		title: "Cursor",
		description: "Cursor CLI ACP agent",
		source: "builtin",
		agentExecutable: "cursor-agent",
		spawn: {
			command: "cursor-agent",
			args: ["acp"],
		},
	},
];

export function isAgentAvailable(agent: AgentDescriptor): boolean {
	return commandExists(agent.agentExecutable);
}

export function toAgentInfo(
	descriptor: AgentDescriptor,
	state: AgentInfo["state"],
	error?: string,
): AgentInfo {
	return {
		id: descriptor.id,
		backend: descriptor.backend,
		name: descriptor.name,
		title: descriptor.title,
		version: descriptor.version,
		description: descriptor.description,
		icon: descriptor.icon,
		source: descriptor.source,
		state,
		available: state !== "unavailable" && state !== "failed",
		error,
	};
}

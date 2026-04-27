import { npxCommand } from "@/config";
import { commandExists } from "@/utils";
import type { AgentDescriptor, AgentInfo, AgentSpawnCommand } from "./types";

export const BUILTIN_AGENT_DESCRIPTORS: AgentDescriptor[] = [
	{
		id: "codex",
		backend: "codex",
		name: "Codex",
		title: "Codex",
		source: "builtin",
		spawn: {
			command: npxCommand,
			args: ["-yes", "@zed-industries/codex-acp"],
			checkCommand: npxCommand,
		},
	},
	{
		id: "opencode",
		backend: "opencode",
		name: "OpenCode",
		title: "OpenCode",
		source: "builtin",
		spawn: {
			command: "opencode",
			args: ["acp"],
			checkCommand: "opencode",
		},
	},
	{
		id: "claude-code",
		backend: "claude-code",
		name: "Claude Code",
		title: "Claude Code",
		source: "builtin",
		spawn: {
			command: npxCommand,
			args: ["-yes", "@agentclientprotocol/claude-agent-acp"],
			checkCommand: npxCommand,
		},
	},
];

export function isSpawnAvailable(spawn: AgentSpawnCommand): boolean {
	return commandExists(spawn.checkCommand ?? spawn.command);
}

export function getSpawnCheck(spawn: AgentSpawnCommand) {
	const command = spawn.checkCommand ?? spawn.command;
	return {
		command,
		available: commandExists(command),
	};
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

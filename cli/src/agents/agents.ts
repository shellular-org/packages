import type { AiBackend } from "@shellular/protocol";
import { npxCommand } from "@/config";
import { commandExists } from "@/utils";
import type { AgentDescriptor, AgentInfo } from "./types";

export const BUILTIN_AGENT_DESCRIPTORS: Record<AiBackend, AgentDescriptor> = {
	codex: {
		id: "codex",
		name: "Codex",
		title: "Codex",
		agentExecutable: "codex",
		spawn: {
			command: npxCommand,
			args: ["-yes", "@zed-industries/codex-acp"],
		},
	},
	opencode: {
		id: "opencode",
		name: "OpenCode",
		title: "OpenCode",
		agentExecutable: "opencode",
		spawn: {
			command: "opencode",
			args: ["acp"],
		},
	},
	"claude-code": {
		id: "claude-code",
		name: "Claude Code",
		title: "Claude Code",
		agentExecutable: "claude",
		spawn: {
			command: npxCommand,
			args: ["-y", "@agentclientprotocol/claude-agent-acp"],
		},
	},
	copilot: {
		id: "copilot",
		name: "GitHub Copilot",
		title: "GitHub Copilot",
		agentExecutable: "copilot",
		spawn: {
			command: npxCommand,
			args: ["-y", "@github/copilot@1.0.39", "--acp"],
		},
	},
	cursor: {
		id: "cursor",
		name: "Cursor",
		title: "Cursor",
		agentExecutable: "cursor-agent",
		// disabled for now because cursor's ACP is buggy
		// it doesn't return session notifications for session/load, due to which
		// we are unable to display existing chats
		disabled: true,
		spawn: {
			command: "cursor-agent",
			args: ["acp"],
		},
	},
	pi: {
		id: "pi",
		name: "Pi",
		title: "Pi",
		agentExecutable: "pi",
		spawn: {
			command: npxCommand,
			args: ["-y", "pi-acp"],
		},
	},
	hermes: {
		id: "hermes",
		name: "Hermes",
		title: "Hermes (beta)",
		agentExecutable: "hermes",
		spawn: {
			command: "hermes",
			args: ["acp"],
		},
	},
};

export function isAgentAvailable(agent: AgentDescriptor): boolean {
	return !agent.disabled && commandExists(agent.agentExecutable);
}

export function toAgentInfo(
	descriptor: AgentDescriptor,
	state: AgentInfo["state"],
	error?: string,
): AgentInfo {
	return {
		id: descriptor.id,
		backend: descriptor.id,
		name: descriptor.name,
		title: descriptor.title,
		version: descriptor.version,
		description: descriptor.description,
		icon: descriptor.icon,
		state,
		available: state !== "unavailable" && state !== "failed",
		error,
	};
}

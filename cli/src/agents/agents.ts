import type { AgentId } from "@shellular/protocol";
import { npxCommand } from "@/config";
import type { AgentDescriptor, AgentInfo } from "./types";

export const BUILTIN_AGENT_DESCRIPTORS: Record<AgentId, AgentDescriptor> = {
	codex: {
		id: "codex",
		name: "Codex",
		title: "Codex",
		registryId: "codex-acp",
		agentExecutable: "codex",
		installationCommands: {
			npm: {
				os: ["all"],
				command: "npm i -g @openai/codex",
			},
			Homebrew: {
				os: ["macos", "linux"],
				command: "brew install codex",
			},
			Shell: {
				os: ["macos", "linux"],
				command:
					"curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh",
			},
		},
		spawn: {
			command: npxCommand,
			args: ["-yes", "@zed-industries/codex-acp"],
		},
	},
	opencode: {
		id: "opencode",
		name: "OpenCode",
		title: "OpenCode",
		registryId: "opencode",
		agentExecutable: "opencode",
		installationCommands: {
			Shell: {
				os: ["macos", "linux"],
				command: "curl -fsSL https://opencode.ai/install | bash",
			},
			npm: {
				os: ["all"],
				command: "npm i -g opencode-ai",
			},
			bun: {
				os: ["all"],
				command: "bun add -g opencode-ai",
			},
			Homebrew: {
				os: ["macos", "linux"],
				command: "brew install anomalyco/tap/opencode",
			},
			paru: {
				os: ["linux"],
				command: "paru -S opencode",
			},
		},
		spawn: {
			command: "opencode",
			args: ["acp"],
		},
	},
	"claude-code": {
		id: "claude-code",
		name: "Claude Code",
		title: "Claude Code",
		registryId: "claude-acp",
		agentExecutable: "claude",
		installationCommands: {
			Shell: {
				os: ["linux", "macos"],
				command: "curl -fsSL https://claude.ai/install.sh | bash",
			},
			Homebrew: {
				os: ["macos", "linux"],
				command: "brew install --cask claude-code",
			},
			WinGet: {
				os: ["windows"],
				command: "winget install Anthropic.ClaudeCode",
			},
			PowerShell: {
				os: ["windows"],
				command: "irm https://claude.ai/install.ps1 | iex",
			},
			CMD: {
				os: ["windows"],
				command:
					"curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd",
			},
		},
		spawn: {
			command: npxCommand,
			args: ["-y", "@agentclientprotocol/claude-agent-acp"],
		},
	},
	copilot: {
		id: "copilot",
		name: "GitHub Copilot",
		title: "GitHub Copilot",
		registryId: "github-copilot-cli",
		agentExecutable: "copilot",
		installationCommands: {
			Shell: {
				os: ["linux", "macos"],
				command: "curl -fsSL https://gh.io/copilot-install | bash",
			},
			npm: {
				os: ["all"],
				command: "npm install -g @github/copilot",
			},
			PowerShell: {
				os: ["windows"],
				command: "winget install GitHub.Copilot",
			},
			Homebrew: {
				os: ["macos", "linux"],
				command: "brew install copilot-cli",
			},
		},
		spawn: {
			command: npxCommand,
			args: ["-y", "@github/copilot@1.0.39", "--acp"],
		},
	},
	cursor: {
		id: "cursor",
		name: "Cursor",
		title: "Cursor",
		registryId: "cursor",
		note: "Sessions created in the Cursor desktop app aren't listed here — only sessions started with the Cursor CLI (cursor-agent) will show up.\n\nThis requires cursor-agent version 2026.06.03-0bbb28e or newer.",
		agentExecutable: "cursor-agent",
		// disabled for now because cursor's ACP is buggy
		// it doesn't return session notifications for session/load, due to which
		// we are unable to display existing chats
		// edit: works as of cursor-agent version 2026.06.03-0bbb28e
		// disabled: true,
		installationCommands: {
			Shell: {
				os: ["linux", "macos"],
				command: "curl https://cursor.com/install -fsS | bash",
			},
			Powershell: {
				os: ["windows"],
				command: "irm 'https://cursor.com/install?win32=true' | iex",
			},
		},
		spawn: {
			command: "cursor-agent",
			args: ["acp"],
		},
	},
	pi: {
		id: "pi",
		name: "Pi",
		title: "Pi",
		registryId: "pi-acp",
		agentExecutable: "pi",
		installationCommands: {
			npm: {
				os: ["all"],
				command: "npm install -g @earendil-works/pi-coding-agent",
			},
		},
		spawn: {
			command: npxCommand,
			args: ["-y", "pi-acp"],
		},
	},
	hermes: {
		id: "hermes",
		name: "Hermes",
		title: "Hermes",
		agentExecutable: "hermes",
		installationCommands: {
			Shell: {
				os: ["macos", "linux"],
				command:
					"curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash",
			},
			PowerShell: {
				os: ["windows"],
				command:
					"iex (irm https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1)",
			},
		},
		spawn: {
			command: "hermes",
			args: ["acp"],
		},
	},
	"grok-build": {
		id: "grok-build",
		name: "Grok Build",
		title: "Grok Build",
		agentExecutable: "grok",
		installationCommands: {
			Shell: {
				os: ["macos", "linux"],
				command: "curl -fsSL https://x.ai/cli/install.sh | bash",
			},
			PowerShell: {
				os: ["windows"],
				command: "irm https://x.ai/cli/install.ps1 | iex",
			},
		},
		spawn: {
			command: "grok",
			args: ["agent", "stdio"],
		},
	},
};

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
		state,
		available: state !== "unavailable" && state !== "failed",
		error,
	};
}

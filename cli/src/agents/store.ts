import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { config } from "@/config";
import { isErrnoException } from "@/utils";
import type { AgentDescriptor } from "./types";

export const AGENTS_CONFIG_FILE = path.join(config.SHELLULAR_DIR, "agents.json");

const customAgentSchema = z.object({
	id: z.string(),
	name: z.string(),
	title: z.string(),
	description: z.string().optional(),
	icon: z.string().optional(),
	command: z.string(),
	args: z.array(z.string()).default([]),
	env: z.record(z.string(), z.string()).optional(),
	cwd: z.string().optional(),
});

const agentsConfigSchema = z.object({
	disabled: z.array(z.string()).default([]),
	custom: z.array(customAgentSchema).default([]),
});

export type CustomAgentConfig = z.infer<typeof customAgentSchema>;
export type AgentsConfig = z.infer<typeof agentsConfigSchema>;

export type CustomAgentInput = Omit<CustomAgentConfig, "title" | "args"> & {
	title?: string;
	args?: string[];
};

export function readAgentsConfig(): AgentsConfig {
	try {
		const raw = fs.readFileSync(AGENTS_CONFIG_FILE, "utf-8");
		return agentsConfigSchema.parse(JSON.parse(raw));
	} catch (err) {
		if (isErrnoException(err) && err.code === "ENOENT") {
			return { disabled: [], custom: [] };
		}
		throw err;
	}
}

export function writeAgentsConfig(configData: AgentsConfig) {
	fs.mkdirSync(path.dirname(AGENTS_CONFIG_FILE), { recursive: true });
	fs.writeFileSync(
		AGENTS_CONFIG_FILE,
		JSON.stringify(agentsConfigSchema.parse(configData), null, 2),
		"utf-8",
	);
}

export function toCustomDescriptor(agent: CustomAgentConfig): AgentDescriptor {
	return {
		id: agent.id,
		name: agent.name,
		title: agent.title,
		description: agent.description,
		icon: agent.icon,
		source: "custom",
		agentExecutable: agent.command,
		installationCommands: {},
		spawn: {
			command: agent.command,
			args: agent.args,
			env: agent.env,
			cwd: agent.cwd,
		},
	};
}

export function normalizeCustomAgentInput(
	input: CustomAgentInput,
	existingIds: Set<string>,
	options?: { allowExistingId?: string },
): CustomAgentConfig {
	const id = input.id.trim();
	const name = input.name.trim();
	const title = (input.title?.trim() || name).trim();
	const command = input.command.trim();
	const args = (input.args ?? []).map((arg) => arg.trim()).filter(Boolean);
	const description = input.description?.trim() || undefined;
	const icon = input.icon?.trim() || undefined;
	const cwd = input.cwd?.trim() || undefined;
	const env = normalizeEnv(input.env);

	if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
		throw new Error("Agent ID must be a lowercase slug.");
	}
	if (existingIds.has(id) && id !== options?.allowExistingId) {
		throw new Error(`Agent "${id}" already exists.`);
	}
	if (!name) {
		throw new Error("Agent name is required.");
	}
	if (!command) {
		throw new Error("Agent command is required.");
	}

	return {
		id,
		name,
		title,
		description,
		icon,
		command,
		args,
		env,
		cwd,
	};
}

function normalizeEnv(env: Record<string, string> | undefined) {
	if (!env) return undefined;
	const entries = Object.entries(env)
		.map(([key, value]) => [key.trim(), value] as const)
		.filter(([key]) => key);
	return entries.length ? Object.fromEntries(entries) : undefined;
}

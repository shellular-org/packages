import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";

import type * as acp from "@agentclientprotocol/sdk";
import type { ACP } from "./base";
import { ClaudeCode } from "./claude-code";
import { Codex } from "./codex";
import { Cursor } from "./cursor";
import { OpenCode } from "./opencode";
import { Pi } from "./pi";

const rl = readline.createInterface({ input, output });

async function ask(question: string): Promise<string> {
	return rl.question(question);
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderUpdate(notification: acp.SessionNotification) {
	const u = notification.update;
	console.log("\n\x1b[2m[session/update]\x1b[0m", u.sessionUpdate);
	switch (u.sessionUpdate) {
		case "agent_message_chunk":
			if (u.content.type === "text") {
				process.stdout.write(u.content.text);
			}
			break;
		case "agent_thought_chunk":
			if (u.content.type === "text") {
				process.stdout.write(`\x1b[2m${u.content.text}\x1b[0m`); // dim
			}
			break;
		case "tool_call":
			console.log(
				`\n\x1b[33m⚙  ${u.title}, id=${u.toolCallId} [${u.status}]\x1b[0m`,
			);
			console.log(`Kind: ${u.kind}`);
			if (u.rawInput) {
				console.log(`Input: ${JSON.stringify(u.rawInput)}`);
			}
			if (u.rawOutput) {
				console.log(`Output: ${JSON.stringify(u.rawOutput)}`);
			}
			console.log("birajlog", JSON.stringify(u, null, 2));
			break;
		case "tool_call_update":
			console.log(`\x1b[33m⚙  tool:${u.toolCallId} → ${u.status}\x1b[0m`);
			console.log("birajlog", JSON.stringify(u, null, 2));
			break;
		case "plan":
			console.log("\n\x1b[36m📋 Plan:\x1b[0m");
			for (const entry of u.entries) {
				const icon =
					entry.status === "completed"
						? "✓"
						: entry.status === "in_progress"
							? "▶"
							: "○";
				console.log(`  ${icon} ${entry.content}`);
			}
			break;
		case "usage_update":
			break;
		default:
			break;
	}
}

// ── Agent selection ───────────────────────────────────────────────────────────

async function pickAgent(): Promise<ACP> {
	while (true) {
		const choice = await ask(
			"Choose agent (1=Codex, 2=OpenCode, 3=ClaudeCode, 4=Cursor, 5=Pi): ",
		);
		if (choice === "1") {
			const agent = Codex.create();
			if (!agent) throw new Error("Codex not found. Is it installed?");
			return agent;
		}
		if (choice === "2") {
			const agent = OpenCode.create();
			if (!agent) throw new Error("OpenCode not found. Is it installed?");
			return agent;
		}
		if (choice === "3") {
			const agent = ClaudeCode.create();
			if (!agent) throw new Error("ClaudeCode not found. Is it installed?");
			return agent;
		}
		if (choice === "4") {
			const agent = Cursor.create();
			if (!agent) throw new Error("Cursor not found. Is it installed?");
			return agent;
		}
		if (choice === "5") {
			const agent = Pi.create();
			if (!agent) throw new Error("Pi not found. Is it installed?");
			return agent;
		}
		console.log("Invalid choice, try again.");
	}
}

// ── Session selection ─────────────────────────────────────────────────────────

async function pickSession(agent: ACP): Promise<acp.SessionInfo> {
	console.log("\nListing sessions...");
	const sessions = await agent.listSessions({});

	if (sessions.length === 0) {
		throw new Error("No sessions found.");
	}

	console.log("\nSessions:");
	for (let i = 0; i < sessions.length; i++) {
		const s = sessions[i];
		const title = s.title ?? "(no title)";
		const updated = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : "";
		console.log(`  ${i + 1}. ${title} — ${s.sessionId} ${updated}`);
	}

	while (true) {
		const raw = await ask(`\nPick a session (1-${sessions.length}): `);
		const idx = Number.parseInt(raw, 10) - 1;
		if (idx >= 0 && idx < sessions.length) {
			return sessions[idx];
		}
		console.log("Out of range, try again.");
	}
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
	const agent = await pickAgent();

	console.log("\nInitializing ACP connection...");
	await agent.init();
	console.log("Connected.\n");

	const sessionInfo = await pickSession(agent);

	console.log(`\nLoading session ${sessionInfo.sessionId}...`);
	const { updates } = await agent.loadSession({
		cwd: sessionInfo.cwd,
		sessionId: sessionInfo.sessionId,
		mcpServers: [],
	});
	for (const update of updates) {
		renderUpdate(update);
	}
	console.log(`Session loaded. Replayed ${updates.length} messages.\n`);

	// ── Chat loop ────────────────────────────────────────────────────────────
	console.log('Type your message and press Enter. Type "exit" to quit.\n');

	while (true) {
		const userInput = await ask("\x1b[32mYou:\x1b[0m ");
		if (userInput.trim().toLowerCase() === "exit") break;
		if (!userInput.trim()) continue;

		process.stdout.write("\n\x1b[34mAgent:\x1b[0m ");

		const response = await agent.prompt(
			{
				sessionId: sessionInfo.sessionId,
				prompt: [{ type: "text", text: userInput }],
			},
			{ onUpdate: renderUpdate },
		);

		process.stdout.write("\n");

		console.log(
			"\n\x1b[2m[response]\x1b[0m",
			JSON.stringify(response, null, 2),
		);
	}

	console.log("\nGoodbye.");
	rl.close();
	agent.destroy();
}

main().catch((err) => {
	console.error(err);
	rl.close();
	process.exit(1);
});

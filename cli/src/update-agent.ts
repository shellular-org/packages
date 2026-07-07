import { spawn } from "node:child_process";
import process from "node:process";

import pm2 from "pm2";

import { config, npxCommand } from "@/config";
import {
	type UpdateAgentProgress,
	UpdateAgentTopic,
	type UpdateRequest,
} from "@/update-agent-protocol";

/**
 * Body of the `shellular-update-agent` PM2 process. See update-agent-protocol.ts
 * for why this exists as a separate sibling process.
 *
 * Lifecycle: PM2 launches this via the hidden `__update_agent` command. It stays
 * idle, connected to the PM2 daemon, listening on the IPC bus. On an UPDATE
 * request it installs the new version (unless the daemon already did) and
 * restarts the daemon, then — last of all — restarts itself so any change to the
 * agent's own code takes effect too. PM2 owns both relaunches, so both survive.
 */

// Timestamped line to the agent's stdout — PM2 pipes this to the stable
// update-agent.log, our authoritative record of what an update did.
function log(msg: string): void {
	process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

function logErr(msg: string): void {
	process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);
}

/** Best-effort progress frame back to whoever is watching the PM2 bus. */
function emitProgress(progress: UpdateAgentProgress): void {
	// process.send exists because PM2 launches us with an IPC channel.
	process.send?.({ type: "process:msg", data: progress });
}

function connectPm2(): Promise<void> {
	return new Promise((resolve, reject) => {
		pm2.connect((err) => {
			if (err) reject(err);
			else resolve();
		});
	});
}

function runCommand(cmd: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		log(`$ ${cmd} ${args.join(" ")}`);
		const child = spawn(cmd, args, {
			// Inherit our stdio so the child's output lands in the agent log too.
			stdio: ["ignore", "inherit", "inherit"],
			shell: process.platform === "win32",
			cwd: config.SHELLULAR_DIR,
			env: process.env,
		});
		child.on("close", (code) => {
			if (code === 0) resolve();
			else
				reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
		});
		child.on("error", reject);
	});
}

async function installShellular(req: UpdateRequest): Promise<void> {
	const spec = `shellular@${req.version}`;
	if (req.installedGlobally) {
		await runCommand("npm", ["install", "-g", spec]);
	} else {
		// Prime the npx cache for the requested version. The daemon relaunch below
		// runs `npx -y shellular@<version> start`, which resolves the same spec.
		await runCommand(npxCommand, ["-y", spec, "--version"]);
	}
}

/**
 * Restart the daemon onto freshly-installed code. We can't `pm2.restart` the
 * daemon by name and have it pick up a *new npm version*, because PM2 restart
 * re-execs the same recorded script path — for a global/npx install that path is
 * the old version's bin. So instead we delete + re-start it exactly the way the
 * CLI does. But the agent doesn't know the daemon's launch internals; the daemon
 * hands us the resolved start args, and we invoke the (now-updated) `shellular`
 * binary to do the start, which re-registers the daemon under PM2.
 */
async function restartDaemon(req: UpdateRequest): Promise<void> {
	emitProgress({
		kind: "shellular:update-agent:progress",
		phase: "restarting-daemon",
	});
	log("Restarting the Shellular daemon onto the new version...");

	// Stop the currently-running (old) daemon. `stop --no-delete` keeps PM2's
	// record so a subsequent `start` reuses the slot; but because the code path
	// changed we prefer a clean delete+start via the updated binary. Both the
	// stop and the start go through the *updated* `shellular` CLI.
	if (req.installedGlobally) {
		await runCommand("shellular", ["stop"]);
		await runCommand("shellular", [
			...req.startArgs,
			"start",
			"--no-log-stream",
		]);
	} else {
		await runCommand(npxCommand, ["shellular", "stop"]);
		await runCommand(npxCommand, [
			"-y",
			`shellular@${req.version}`,
			...req.startArgs,
			"start",
			"--no-log-stream",
		]);
	}
	log("Daemon restarted.");
}

/**
 * Quote an argv token for a POSIX `sh -c` string (single-quote wrap, escape
 * embedded quotes the usual `'\''` way).
 */
function shQuote(token: string): string {
	return `'${token.replace(/'/g, `'\\''`)}'`;
}

/**
 * Replace ourselves LAST, from the freshly-installed code.
 *
 * We can't `pm2.restart(self)`: PM2 re-execs our *recorded script path*, which for
 * an npx launch is the version-pinned old cache path — so a restart would just
 * relaunch the old agent. Instead we spawn the updated `shellular`
 * `__respawn_update_agent`, which deletes this agent and re-`pm2.start`s it from
 * the NEW version's script path.
 *
 * That respawn process must NOT stay our OS child: it calls `pm2.delete` on us,
 * and PM2 tree-kills the target's whole descendant tree — which would include the
 * respawn process itself, killing it mid-flight. So we orphan it to PID 1 first
 * (via a backgrounding `sh -c`, same trick as the legacy worker) so it survives
 * our teardown and finishes recreating the agent. Control effectively never
 * returns here — PM2 kills this process as part of the delete.
 */
async function restartSelf(req: UpdateRequest): Promise<void> {
	emitProgress({
		kind: "shellular:update-agent:progress",
		phase: "restarting-agent",
	});
	log("Recreating the update-agent from the new version (final step)...");

	const command = req.installedGlobally ? "shellular" : npxCommand;
	const args = req.installedGlobally
		? ["__respawn_update_agent"]
		: ["-y", `shellular@${req.version}`, "__respawn_update_agent"];

	if (process.platform === "win32") {
		const child = spawn(command, args, {
			detached: true,
			stdio: ["ignore", "ignore", "ignore"],
			cwd: config.SHELLULAR_DIR,
			env: process.env,
		});
		child.unref();
	} else {
		const innerCmd = [command, ...args].map(shQuote).join(" ");
		const child = spawn("/bin/sh", ["-c", `${innerCmd} &`], {
			detached: true,
			stdio: ["ignore", "ignore", "ignore"],
			cwd: config.SHELLULAR_DIR,
			env: process.env,
		});
		child.unref();
	}

	log("Respawn handed off; awaiting PM2 teardown.");
}

async function handleUpdate(req: UpdateRequest): Promise<void> {
	try {
		if (!req.alreadyInstalled) {
			emitProgress({
				kind: "shellular:update-agent:progress",
				phase: "installing",
			});
			log(`Installing shellular@${req.version}...`);
			await installShellular(req);
		} else {
			log("Daemon already installed the new version; skipping install.");
		}

		await restartDaemon(req);

		// Self-replacement is last — after this the process is torn down.
		await restartSelf(req);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logErr(`Update failed: ${message}`);
		emitProgress({
			kind: "shellular:update-agent:progress",
			phase: "error",
			message,
		});
	}
}

export async function runUpdateAgent(): Promise<void> {
	log(
		`update-agent starting (shellular v${config.VERSION}, pid ${process.pid})`,
	);

	// Establish (and hold) a PM2 connection. The actual daemon/agent restarts are
	// driven by spawning the updated `shellular` CLI, but connecting here is a
	// cheap liveness check that PM2 is reachable, and keeps the door open for
	// future direct-bus features. A failure to connect means PM2 is gone — exit
	// non-zero so PM2 (if it comes back) knows we failed.
	try {
		await connectPm2();
		log("Connected to PM2.");
	} catch (err) {
		logErr(
			`Failed to connect to PM2: ${err instanceof Error ? err.message : String(err)}`,
		);
		process.exit(1);
	}

	process.on("message", (packet: unknown) => {
		if (!packet || typeof packet !== "object") return;
		const { topic, data } = packet as { topic?: string; data?: unknown };

		if (topic === UpdateAgentTopic.PING) {
			log("PING received.");
			emitProgress({
				kind: "shellular:update-agent:progress",
				phase: "done",
				message: "pong",
			});
			return;
		}

		if (topic === UpdateAgentTopic.UPDATE) {
			log("UPDATE request received.");
			void handleUpdate(data as UpdateRequest);
			return;
		}
	});

	log("update-agent ready; awaiting IPC messages.");

	// Keep the event loop alive forever. The `message` listener already holds the
	// IPC channel open, but this makes the intent explicit and survives any future
	// refactor that removes the listener.
	await new Promise<never>(() => {});
}

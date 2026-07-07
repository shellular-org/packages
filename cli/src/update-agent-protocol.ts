/**
 * IPC contract between the Shellular daemon and its sibling `shellular-update-agent`
 * PM2 process.
 *
 * Why a separate agent at all: the daemon is a PM2-managed process. When you ask
 * PM2 to stop/delete/restart the daemon, PM2 SIGTERMs the daemon *and its whole
 * process tree*. So the daemon can't reliably run its own "stop me, install, start
 * me again" worker as a child — that worker gets tree-killed mid-update (this is
 * exactly why the old orphan-to-PID-1 trick existed).
 *
 * The update-agent sidesteps that entirely: it's a *sibling* of the daemon (both
 * are children of PM2's God daemon, not of each other). PM2 tearing down the
 * daemon never touches the agent, so the agent can safely `pm2 restart` the daemon
 * onto freshly-installed code — and restart itself too, because PM2 owns that
 * relaunch.
 *
 * Messages travel over PM2's IPC bus:
 *   daemon -> agent : pm2.sendDataToProcessId({ type: "process:msg", topic, data })
 *                     received in the agent via process.on("message", packet)
 *   agent  -> daemon: process.send({ type: "process:msg", data }) — observed by the
 *                     daemon (or CLI) via pm2.launchBus. Best-effort only: during a
 *                     restart the daemon is going away, so the agent's authoritative
 *                     record is its own log file, not this channel.
 */

/** PM2 packet `topic`s the agent listens for. */
export const UpdateAgentTopic = {
	/**
	 * Update Shellular. The agent installs `shellular@latest` (or the requested
	 * version), then restarts the daemon and — if its own code changed — itself,
	 * via PM2 so both relaunches survive.
	 */
	UPDATE: "shellular:update-agent:update",
	/** Liveness probe. Agent replies with a PONG on the bus. */
	PING: "shellular:update-agent:ping",
} as const;

export type UpdateAgentTopic =
	(typeof UpdateAgentTopic)[keyof typeof UpdateAgentTopic];

/** daemon -> agent payload for {@link UpdateAgentTopic.UPDATE}. */
export type UpdateRequest = {
	/**
	 * npm dist-tag or exact version to install, e.g. "latest" or "0.0.41".
	 * The daemon resolves what it wants; the agent just installs it.
	 */
	version: string;
	/** True when `shellular` is installed globally (`npm i -g`) vs run via npx. */
	installedGlobally: boolean;
	/** Options to re-pass to `shellular start` so the relaunch keeps its config. */
	startArgs: string[];
	/**
	 * Whether the daemon already ran `npm install` itself before handing off.
	 * When true the agent skips the install and only performs the restarts —
	 * this is the normal path (daemon installs, agent restarts). When false the
	 * agent does the install too (used if the daemon can't, e.g. a bare relaunch).
	 */
	alreadyInstalled: boolean;
};

/** agent -> bus progress frames (best-effort; the log file is authoritative). */
export const UpdateAgentEvent = {
	MSG: "process:msg",
} as const;

export type UpdateAgentProgress = {
	kind: "shellular:update-agent:progress";
	phase:
		| "installing"
		| "restarting-daemon"
		| "restarting-agent"
		| "done"
		| "error";
	message?: string;
};

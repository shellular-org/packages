#!/usr/bin/env node

import os from "node:os";
import path from "node:path";

import { checkbox, confirm } from "@inquirer/prompts";
import {
	type ClientUserInfo,
	type HostInfo,
	type HostUpdateMsg,
	MsgType,
	type SessionClientJoinMsg,
	type SessionClientLeftMsg,
} from "@shellular/protocol";
import chalk from "chalk";
import { Command } from "commander";
import qrcode from "qrcode-terminal";
import { AgentsManager } from "@/agents";
import {
	ensureSingleInstance,
	releaseBootLock,
	updateBootLock,
} from "@/boot-lock";
import { startCaffeinate, stopCaffeinate } from "@/caffeinate";
import {
	deleteKnownClient,
	getClientApproval,
	readKnownClients,
	upsertClient,
	writeKnownClients,
} from "@/clients";
import { config, ensureConfig } from "@/config";
import { connectWithReconnect } from "@/connection";
import {
	type DaemonOptions,
	type DaemonStartOptions,
	disableStartup,
	enableStartup,
	restartDaemon,
	showDaemonLogs,
	showDaemonStatus,
	startDaemon,
	stopDaemon,
} from "@/daemon";
import { getKeyBase64, initEncryption } from "@/encryption";
import { initFilesystemHandler } from "@/filesystem";
import { logger } from "@/logger";
import { initPortsHandler } from "@/ports";
import { preStart } from "@/pre-start";
import { cleanupProxy, initProxyHandler } from "@/proxy";
import { ServerUrl } from "@/server-url";
import { initBatteryStream, initSysmonHandler } from "@/sysmon";
import { initTerminalHandler } from "@/terminal";
import { checkForUpdate, getUpdateInfo } from "@/update-check";
import { showSelfUpdateLogs } from "@/update-logs";
import { runSelfUpdate } from "@/update-runner";
import {
	addAllowedUser,
	checkUserGate,
	classifyEntry,
	isUserAllowlistActive,
	normalizeEntry,
	readAllowedUsers,
	removeAllowedUser,
} from "@/users";
import { updateAndStartShellular } from "./update-and-start";

ensureConfig();

const NEW_CLIENT_APPROVAL_POLICIES = [
	"always-reject",
	"always-allow",
	"requires-approval",
] as const;

type UnknownClientApprovalPolicy =
	(typeof NEW_CLIENT_APPROVAL_POLICIES)[number];
const DEFAULT_NEW_CLIENT_APPROVAL_POLICY = "requires-approval";

function parseNewClientApprovalPolicy(
	value: string,
): UnknownClientApprovalPolicy {
	if (
		NEW_CLIENT_APPROVAL_POLICIES.includes(value as UnknownClientApprovalPolicy)
	) {
		return value as UnknownClientApprovalPolicy;
	}

	throw new Error(
		`Invalid value for --unknown-clients: ${value}. Expected one of ${NEW_CLIENT_APPROVAL_POLICIES.join(", ")}.`,
	);
}

type CliOptions = {
	server: string;
	dir: string;
	unknownClients: UnknownClientApprovalPolicy;
	qr: boolean;
};

type ClientsCommandOptions = {
	delete?: string;
};

type DaemonStopOptions = {
	delete: boolean;
};

/**
 * `isDaemon` is an internal flag to indicate whether the CLI is running in daemon mode (started with __daemon command).
 * In this mode, certain behaviors are adjusted, such as how client approvals are handled and what notifications are shown,
 * to better suit a background service context.
 */
type RunCliOptions = CliOptions & { isDaemon?: boolean };

function createProgram(): Command {
	const program = new Command()
		.name(config.NAME)
		.description(config.DESCRIPTION)
		.version(config.VERSION)
		.showHelpAfterError()
		.allowExcessArguments(false)
		.option("--server <url>", "Shellular server URL", config.DEFAULT_SERVER_URL)
		.option("--dir <path>", "Working directory", os.homedir())
		.option("--no-qr", "Do not display QR code in terminal")
		.option(
			"--unknown-clients <policy>",
			`unknown clients approval policy (${NEW_CLIENT_APPROVAL_POLICIES.join(", ")})`,
			parseNewClientApprovalPolicy,
			DEFAULT_NEW_CLIENT_APPROVAL_POLICY,
		);

	const resolveDaemonOptions = (
		options: Partial<DaemonOptions>,
		command: Command,
	): DaemonOptions => {
		const globals =
			command.parent?.opts<CliOptions>() ?? program.opts<CliOptions>();
		return {
			server: options.server ?? globals.server,
			dir: options.dir ?? globals.dir,
			unknownClients: options.unknownClients ?? globals.unknownClients,
			qr: options.qr ?? globals.qr,
		};
	};

	program
		.command("start")
		.option(
			"--no-log-stream",
			"Do not stream logs to the console. Just start the daemon and exit.",
		)
		.description("Start Shellular in the background as a daemon")
		.action(async (options: Partial<DaemonStartOptions>, command: Command) => {
			await startDaemon(
				resolveDaemonOptions(options, command),
				options.logStream || false,
			);
		});

	program
		.command("stop")
		.description("Stop the Shellular daemon")
		.option("--no-delete", "Do not delete the daemon process from PM2")
		.action(async (options: DaemonStopOptions) => {
			await stopDaemon(options.delete);
		});

	program
		.command("restart")
		.description("Restart the Shellular daemon")
		.action(async () => {
			await restartDaemon();
		});

	program
		.command("startup")
		.description(
			"Enable Shellular to start automatically on boot (requires the daemon to be running)",
		)
		.action(async () => {
			await enableStartup();
		});

	program
		.command("unstartup")
		.description("Disable automatic startup of Shellular on boot")
		.action(async () => {
			await disableStartup();
		});

	program
		.command("logs")
		.description("Stream Shellular daemon logs")
		.option(
			"--self-updates",
			"List self-update logs and stream the latest instead",
		)
		.action(async (options: { selfUpdates?: boolean }) => {
			if (options.selfUpdates) {
				await showSelfUpdateLogs();
				return;
			}
			await showDaemonLogs();
		});

	program
		.command("status")
		.description("Show Shellular daemon status")
		.action(async () => {
			await showDaemonStatus();
		});

	program
		.command("__update_and_start", { hidden: true })
		.description("Update Shellular and start the daemon")
		.action(async () => {
			await updateAndStartShellular();
		});

	program
		.command("__daemon", { hidden: true })
		.description("Internal daemon")
		.action(async (options: Partial<DaemonOptions>, command: Command) => {
			await runCli({
				...resolveDaemonOptions(options, command),
				isDaemon: true,
			});
		});

	const users = program
		.command("users")
		.description(
			"Manage the account allowlist. While it is non-empty, only clients signed in with a listed account may connect, and unauthenticated clients are always rejected. Each entry is either an account email or a stable user ID.",
		);

	users
		.command("list", { isDefault: true })
		.description("List allowed accounts")
		.action(async () => {
			const allowed = await readAllowedUsers();
			if (allowed.length === 0) {
				logger.log("No account allowlist — any approved client may connect.");
				logger.log(
					`Add one with \`${chalk.cyan("npx shellular users add <email-or-id>")}\` to restrict access.\n`,
				);
				logWhereToFindIdentity();
				return;
			}

			logger.log(
				chalk.green(
					`Account allowlist is active (${allowed.length} ${allowed.length === 1 ? "entry" : "entries"}).`,
				),
			);
			logger.log(
				chalk.gray(
					"Unauthenticated clients are rejected while it is active.\n",
				),
			);
			for (const entry of allowed) {
				const tag =
					classifyEntry(entry) === "email"
						? chalk.gray("(email)")
						: chalk.gray("(user ID)");
				logger.log(`  - ${chalk.magentaBright(entry)} ${tag}`);
			}
		});

	users
		.command("add <email-or-id>")
		.description("Allow an account (by email or user ID) to connect")
		.action(async (value: string) => {
			const normalized = normalizeEntry(value);
			if (!isValidAllowlistEntry(normalized)) {
				logger.error(
					chalk.red(`"${value}" is not a valid email address or user ID.\n`),
				);
				logWhereToFindIdentity();
				process.exitCode = 1;
				return;
			}

			const wasEmpty = !(await isUserAllowlistActive());
			if (!(await addAllowedUser(normalized))) {
				logger.log(`${chalk.magentaBright(normalized)} is already allowed.`);
				return;
			}

			logger.log(chalk.green(`Allowed ${chalk.magentaBright(normalized)}.`));

			// Turning the allowlist on is the moment existing devices can start
			// getting rejected, so say so plainly rather than let it surprise them.
			if (wasEmpty) {
				logger.warn(
					`\nThe account allowlist is now active. Clients signed in with any other account — and all unauthenticated clients — will be rejected on their next connection.`,
				);
			}
		});

	users
		.command("remove <email-or-id>")
		.description("Revoke an account, disconnecting all of its devices")
		.action(async (value: string) => {
			const normalized = normalizeEntry(value);
			if (!(await removeAllowedUser(normalized))) {
				logger.error(
					chalk.red(`${normalized} is not in the account allowlist.`),
				);
				process.exitCode = 1;
				return;
			}

			logger.log(chalk.green(`Revoked ${chalk.magentaBright(normalized)}.`));
			if (!(await isUserAllowlistActive())) {
				logger.warn(
					"\nThe account allowlist is now empty, so it no longer gates connections. Any approved client may connect again.",
				);
			}
		});

	program
		.command("clients")
		.description("Manage client device approvals")
		.option("--delete <clientId>", "Delete a known client from the store")
		.action(async (options: ClientsCommandOptions) => {
			try {
				if (options.delete) {
					const deleted = deleteKnownClient(options.delete);
					if (!deleted) {
						logger.error(chalk.red(`Client ${options.delete} was not found.`));
						process.exitCode = 1;
						return;
					}

					logger.log(
						chalk.green(`Deleted client ${options.delete} from known clients.`),
					);
					return;
				}

				const store = readKnownClients();
				const all = Object.values(store);
				if (all.length === 0) {
					logger.log("No known clients yet.");
					return;
				}

				const clientInfoFormatted = (c: (typeof all)[0]) => `
    ${formatClientDeviceInfo(c)}
    ${formatClientUser(c)}
    ${chalk.gray(`App v${c.appVersion}`)}. ${chalk.gray(`first seen: ${new Date(c.firstSeen).toLocaleString()}`)}`;

				const choices = all.map((c) => ({
					name: `${chalk.blueBright(c.clientId)} ${chalk.gray("(not allowed)")}${clientInfoFormatted(c)}`,
					checkedName: `${chalk.blueBright(c.clientId)} ${chalk.gray("(allowed)")}${clientInfoFormatted(c)}`,
					value: c.clientId,
					checked: c.approved,
				}));

				const approvedIds = await checkbox({
					message: `Choose which clients can connect (${all.length} total) — Space to toggle, Enter to save`,
					choices,
					loop: false,
					pageSize: 5,
				});

				const updated = Object.fromEntries(
					all.map((c) => [
						c.clientId,
						{ ...c, approved: approvedIds.includes(c.clientId) },
					]),
				);
				writeKnownClients(updated);
				logger.log(chalk.green("Client approvals saved."));
			} catch (err) {
				if (err instanceof Error && err.name === "ExitPromptError") {
					logger.log("👋 until next time!");
					return;
				}

				logger.error(
					chalk.red(
						`Error managing clients: ${err instanceof Error ? err.message : String(err)}`,
					),
				);
			}
		});

	program.action(async (options: CliOptions) => {
		await runCli(options);
	});

	return program;
}

async function confirmWrapper(message: string): Promise<boolean> {
	try {
		return await confirm({ message });
	} catch (err) {
		logger.error(
			chalk.red(
				`Error in confirmation: ${err instanceof Error ? err.message : String(err)}`,
			),
		);
		return false;
	}
}

function formatClientDeviceInfo({
	deviceManufacturer: manufacturer,
	deviceModel: model,
	deviceIsEmulator: isEmulator,
	platform,
}: {
	deviceManufacturer?: string;
	deviceModel?: string;
	deviceIsEmulator?: boolean;
	platform: string;
}): string {
	manufacturer = manufacturer?.trim() ?? "";
	model = model?.trim() ?? "";

	let deviceName = [manufacturer, model]
		.filter((value, index, values) => value && values.indexOf(value) === index)
		.join(" ");

	if (!deviceName) {
		deviceName = platform;
	} else {
		deviceName = `${deviceName}, ${platform}`;
	}

	return isEmulator
		? `${deviceName} ${chalk.yellowBright("[Emulator]")}`
		: deviceName;
}

function isLikelyEmail(value: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * A valid allowlist entry is either an email or a user ID. We can't validate an
 * ID against the server, so we only reject obviously-broken input: an email
 * shape that's malformed, or an ID with whitespace/`@` that would never match.
 */
function isValidAllowlistEntry(value: string): boolean {
	if (classifyEntry(value) === "email") {
		return isLikelyEmail(value);
	}
	return value.length > 0 && !/\s/.test(value);
}

/** Where a host can grab their account email or user ID to allowlist. */
function logWhereToFindIdentity() {
	logger.log(
		chalk.gray(
			`Find your account email and user ID under the Account tab in the Shellular app, or at ${chalk.underline("https://app.shellular.dev")}.`,
		),
	);
}

/**
 * The signed-in account behind a client. Clients that connected over the legacy
 * path proved no identity at all, which is a fact the host should see before
 * approving them — so it is called out rather than left blank.
 */
function formatClientUser({ user }: { user?: ClientUserInfo }): string {
	return user
		? chalk.magentaBright(user.email)
		: chalk.yellowBright("[Unauthenticated]");
}

async function runCli({
	server,
	dir,
	unknownClients: unknownClientsApproval,
	isDaemon = false,
	qr: showQr,
}: RunCliOptions): Promise<void> {
	const serverUrl = new ServerUrl(server);
	const workDir = path.resolve(dir);

	ensureSingleInstance({
		serverUrl: serverUrl.toApiUrl(),
		workDir,
	});

	const { hostId } = await preStart({ server });

	await initEncryption();

	const line = chalk.gray("─".repeat(34));
	const label = (key: string, value: string) =>
		`${chalk.gray(key.padEnd(17))} ${chalk.white(value)}`;

	logger.log();
	logger.log(chalk.bold.cyan(`Shellular CLI v${config.VERSION}`));
	logger.log(line);

	const centralServerUrl = serverUrl.toApiUrl();
	const serverUrlFormatted =
		new URL(centralServerUrl).origin ===
		new URL(config.DEFAULT_SERVER_URL).origin
			? "default"
			: chalk.underline(centralServerUrl);
	logger.log(label("Server:", serverUrlFormatted));
	logger.log(
		label(
			"Unknown clients:",
			unknownClientsApproval === "always-allow"
				? chalk.red("Always allow")
				: unknownClientsApproval === "always-reject"
					? chalk.yellow("Always reject")
					: chalk.green("Require approval"),
		),
	);

	if (config.SHELLULAR_DEV) {
		logger.log(label("Directory:", workDir));
		logger.log(label("Platform:", config.PLATFORM));
		logger.log(label("Host:", config.HOSTNAME));
	}

	logger.log();

	// Warm the npm "latest version" TTL cache so the first client to join doesn't
	// pay the lookup. The dynamic updateAvailable/latestCliVersion are NOT part of
	// stable host identity — they're re-checked and sent per client-join (in the
	// approval), so they live on the session's updateInfo, not on HostInfo here.
	getUpdateInfo(config.VERSION).catch(() => undefined);

	const hostInfo: HostInfo = {
		id: hostId,
		username: config.USERNAME,
		hostname: config.HOSTNAME,
		platform: config.PLATFORM,
		dir: workDir,
		machineId: config.MACHINE_ID,
		cliVersion: config.VERSION,
		// Only a daemon (PM2-supervised) can safely self-update + restart. A
		// foreground npx/global launch would orphan itself, so the app shows a
		// "please update manually" hint instead of the Update button.
		canSelfUpdate: isDaemon,
	};

	const agentsManager = new AgentsManager();

	const cleanup = () => {
		logger.log("Cleaning up resources...");
		stopCaffeinate();
		releaseBootLock();
		agentsManager.destroy();
	};

	process.on("SIGINT", cleanup); // Ctrl+C
	process.on("SIGTERM", cleanup); // kill / docker stop
	process.on("beforeExit", cleanup);

	process.on("uncaughtException", (err) => {
		logger.error("uncaughtException", err);
		// cleanup();
		// process.exit(1);
	});

	process.on("unhandledRejection", (err) => {
		logger.error("unhandledRejection", err);
		// cleanup();
		// process.exit(1);
	});

	startCaffeinate();

	connectWithReconnect(
		serverUrl.toApiUrl(),
		hostInfo,
		async (conn, isFirst) => {
			try {
				updateBootLock({ connectionId: conn.sessionId });
				cleanupProxy();

				if (isFirst) {
					logger.log(
						chalk.green(
							"✅",
							`Connected to server at ${new Date().toLocaleString()}`,
						),
					);
					logger.log(
						"🔒",
						chalk.green(
							`Messages are ${chalk.underline("end-to-end encrypted")}.`,
						),
					);

					if (showQr) {
						logger.log(
							"📲",
							`Scan the QR code with ${chalk.bold("Shellular app")} to connect.`,
						);

						// Display QR code with hostId:e2eeKey for out-of-band key exchange
						const qrData = `${hostId}:${getKeyBase64()}`;
						logger.log();
						qrcode.generate(qrData, { small: true }, (qr: string) => {
							qr.split("\n").forEach((line) => {
								logger.log(line);
							});

							logger.log();
							logger.log(
								"⚠️ ",
								chalk.yellow.bold(
									"Keep this QR code private — do not share it with anyone.",
								),
							);

							if (config.PLATFORM === "darwin") {
								logger.log(
									"💡",
									"Connection stays active as long as Shellular CLI is running and your laptop is online, even if you lock your screen.",
								);
								logger.log("📌", "Just don't close the laptop lid.");
							}

							logger.log("👋", "Press Ctrl+C to exit.\n");
						});
					} else {
						logger.log("🙈", "Not showing QR code since --no-qr was specified");
					}
				} else {
					logger.log(
						chalk.green(
							`Reconnected to server at ${new Date().toLocaleString()}\n`,
						),
					);
				}

				// Register handlers
				initTerminalHandler(conn, workDir);
				initFilesystemHandler(conn, workDir);
				initSysmonHandler(conn);
				initBatteryStream(conn);
				initProxyHandler(conn);
				initPortsHandler(conn);
				agentsManager.handleConnection(conn);

				conn.on(MsgType.SESSION_ERROR, (data) => {
					logger.error(
						chalk.red(`✗ Connection error: ${data.error ?? "Unknown error"}`),
					);
				});

				conn.on(MsgType.HOST_UPDATE, (msg: HostUpdateMsg) => {
					const { clientId } = msg;

					// Only a daemon (PM2-supervised) can safely self-update: PM2 owns the
					// replacement process. A foreground npx/global launch would orphan
					// itself, so we refuse and ask the user to update manually. The app
					// only shows the Update button when canSelfUpdate, so this guards
					// against stale/rogue clients sending HOST_UPDATE anyway.
					if (!isDaemon) {
						logger.log(
							chalk.yellow(
								`⬆️  Update requested by client ${clientId}, but this is a foreground launch — not self-updating.`,
							),
						);
						conn.send({
							type: MsgType.HOST_UPDATE_RESULT,
							clientId,
							data: {
								status: "error",
								message:
									"This CLI isn't running as a daemon. Update manually with `npx shellular@latest`.",
							},
						});
						return;
					}

					logger.log(chalk.cyan(`⬆️  Update requested by client ${clientId}.`));

					conn.send({
						type: MsgType.HOST_UPDATE_RESULT,
						clientId,
						data: { status: "starting" },
					});

					// Let the "starting" frame flush to the app before we kick off the
					// update (which, for daemon/global, tears this process down).
					setTimeout(async () => {
						conn.send({
							type: MsgType.HOST_UPDATE_RESULT,
							clientId,
							data: { status: "updating" },
						});

						try {
							// Daemon-only: spawns a detached helper that installs the
							// resolved version, then stops this daemon and starts the new
							// one with the same options. The original options are re-passed
							// to `start` so the relaunched daemon keeps server/dir/approval.
							await runSelfUpdate();
							conn.send({
								type: MsgType.HOST_UPDATE_RESULT,
								clientId,
								data: { status: "restarting" },
							});
						} catch (err) {
							const message = err instanceof Error ? err.message : String(err);
							logger.error(chalk.red(`Self-update failed: ${message}`));
							conn.send({
								type: MsgType.HOST_UPDATE_RESULT,
								clientId,
								data: { status: "error", message },
							});
						}
					}, 250);
				});

				conn.on(
					MsgType.SESSION_CLIENT_JOIN,
					async (msg: SessionClientJoinMsg) => {
						const { clientId } = msg.data;

						const deviceSummary = formatClientDeviceInfo(msg.data);
						const userSummary = formatClientUser(msg.data);

						// Approve the joining client, attaching freshly re-checked update
						// info (TTL-cached). The server merges this into session.hostInfo
						// before the SESSION_JOINED handshake, so this specific client
						// sees current update availability even on a long-lived daemon.
						const approve = async () => {
							const update = await getUpdateInfo(config.VERSION).catch(() => ({
								current: config.VERSION,
								latest: undefined,
								updateAvailable: false,
							}));
							conn.send({
								type: MsgType.SESSION_CLIENT_JOIN_RESULT,
								data: {
									clientId,
									approved: true,
									updateAvailable: update.updateAvailable,
									latestCliVersion: update.latest,
								},
							});
						};

						const reject = () => {
							conn.send({
								type: MsgType.SESSION_CLIENT_JOIN_RESULT,
								data: { clientId, approved: false },
							});
						};

						// The account allowlist gates *before* per-device approvals: one
						// account spans many devices, so allowlisting it must cover all of
						// them and revoking it must evict all of them — even devices
						// previously approved by clientId.
						const gate = await checkUserGate(msg.data);
						if (!gate.allowed) {
							reject();
							logger.warn(
								gate.reason === "unauthenticated"
									? `Rejected unauthenticated client ${clientId} (${deviceSummary}): an account allowlist is active. Run \`${chalk.cyan("npx shellular users")}\` to review it.`
									: `Rejected client ${clientId} (${deviceSummary}, ${userSummary}): not in the account allowlist. Run \`${chalk.cyan("npx shellular users add <email-or-id>")}\` to allow it.`,
							);
							return;
						}

						// A positive allowlist match trumps the per-device approval flow: the
						// host has explicitly trusted this account, so every one of its
						// devices connects — even a never-before-seen one — without falling
						// through to the unknown-client policy (which would auto-reject in a
						// daemon). Record it as approved so `shellular clients` reflects it.
						if (gate.allowlisted) {
							upsertClient(msg.data, true);
							await approve();
							return;
						}

						const approval = getClientApproval(clientId);
						if (approval === true) {
							// Previously approved — auto-allow silently
							await approve();
							return;
						}

						if (approval === false) {
							// Previously rejected — silently reject again without notifying
							reject();
							return;
						}

						// approval === null means that it's a new and unknown client

						if (unknownClientsApproval === "always-allow") {
							await approve();
							return;
						}

						if (unknownClientsApproval === "always-reject") {
							reject();
							return;
						}

						// Record as pending/unapproved
						upsertClient(msg.data, false);

						if (!isDaemon) {
							// Foreground: ask the user interactively
							const allow = await confirmWrapper(
								`Allow ${chalk.cyan(clientId)} (${deviceSummary}, ${userSummary}) to connect?`,
							);
							if (allow) {
								upsertClient(msg.data, true);
								await approve();
							} else {
								reject();
							}
						} else {
							// Daemon: auto-reject, instruct user to run shellular clients
							reject();
							logger.warn(
								`Unknown client ${clientId} (${deviceSummary}, ${userSummary}) tried to connect. Run \`${chalk.cyan("npx shellular clients")}\` to approve.`,
							);
						}
					},
				);

				conn.on(MsgType.SESSION_CLIENT_JOINED, async (msg) => {
					upsertClient(
						{
							clientId: msg.data.clientId,
							hostId: msg.data.hostId,
							user: msg.data.user,
							appVersion: msg.data.appVersion,
							platform: msg.data.platform,
							deviceModel: msg.data.deviceModel,
							deviceIsEmulator: msg.data.deviceIsEmulator,
							deviceManufacturer: msg.data.deviceManufacturer,
						},
						true,
					);
					const deviceSummary = formatClientDeviceInfo(msg.data);
					const userSummary = formatClientUser(msg.data);
					agentsManager.notifyClient(msg.data.clientId);

					logger.log();
					logger.log(
						chalk.green(
							`✓ Client ${msg.data.clientId} connected on ${new Date().toLocaleString()}`,
						),
					);
					logger.log(`  - ${chalk.green("User:")} ${userSummary}`);
					logger.log(`  - ${chalk.green("Device:")} ${deviceSummary}`);
					logger.log(
						`  - ${chalk.green("App Version:")} v${msg.data.appVersion}\n`,
					);
				});

				conn.on(MsgType.SESSION_CLIENT_LEFT, (data: SessionClientLeftMsg) => {
					logger.log(
						chalk.red(
							`✗ Client ${data.data.clientId} disconnected on ${new Date().toLocaleString()}`,
						),
					);
				});
			} catch {
				logger.log(`Connection ID: ${conn.sessionId}`);
				logger.log("Waiting for client...\n");
			}
		},
	);
}

async function main(): Promise<void> {
	try {
		checkForUpdate(config.VERSION).catch(() => {});
		const program = createProgram();
		await program.parseAsync(process.argv);
	} catch (err) {
		logger.error(chalk.red(`${String(err)}`));
		process.exit(1);
	}
}

main().catch((err) => {
	process.stderr.write(`${String(err)}\n`);
	process.exit(1);
});

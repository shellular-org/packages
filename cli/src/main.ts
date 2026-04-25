#!/usr/bin/env node

import os from "node:os";
import path from "node:path";

import { checkbox, confirm } from "@inquirer/prompts";
import type { HostInfo } from "@shellular/protocol";
import {
	type AiAvailabilityResultMsg,
	MsgType,
	type SessionClientJoinMsg,
	type SessionClientLeftMsg,
} from "@shellular/protocol";
import chalk from "chalk";
import { Command } from "commander";
import qrcode from "qrcode-terminal";
import { initAiHandler } from "@/ai";
import {
	notifyExtensionClientPresence,
	notifyExtensionClientsSnapshot,
	notifyExtensionCliInfo,
} from "@/ai/copilot";
import { AiManager } from "@/ai/index";
import {
	ensureSingleInstance,
	releaseBootLock,
	updateBootLock,
} from "@/boot-lock";
import { startCaffeinate, stopCaffeinate } from "@/caffeinate";
import {
	getClientApproval,
	readKnownClients,
	upsertClient,
	writeKnownClients,
} from "@/clients";
import { config, ensureConfig, getOrRegisterHostId } from "@/config";
import { connectWithReconnect } from "@/connection";
import {
	showDaemonLogs,
	showDaemonStatus,
	startDaemon,
	stopDaemon,
} from "@/daemon";
import { getKeyBase64, initEncryption } from "@/encryption";
import { initFilesystemHandler } from "@/filesystem";
import { installVsCodeExtension } from "@/install-extension";
import { logger } from "@/logger";
import { notify } from "@/notify";
import { initPortsHandler } from "@/ports";
import { cleanupProxy, initProxyHandler } from "@/proxy";
import { ServerUrl } from "@/server-url";
import { initBatteryStream, initSysmonHandler } from "@/sysmon";
import { initTerminalHandler } from "@/terminal";
import { checkForUpdate } from "@/update-check";
import packageJson from "../package.json";

const DEFAULT_SERVER_URL = "wss://api.shellular.dev";
const APP_URL = "https://shellular.dev";

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
	installVsPlugin: boolean;
	unknownClients: UnknownClientApprovalPolicy;
};

type DaemonOptions = Pick<CliOptions, "server" | "dir" | "unknownClients">;

/**
 * `isDaemon` is an internal flag to indicate whether the CLI is running in daemon mode (started with __daemon command).
 * In this mode, certain behaviors are adjusted, such as how client approvals are handled and what notifications are shown,
 * to better suit a background service context.
 */
type RunCliOptions = CliOptions & { isDaemon?: boolean };

function createProgram(): Command {
	const program = new Command()
		.name(config.NAME)
		.description(packageJson.description)
		.version(packageJson.version)
		.showHelpAfterError()
		.allowExcessArguments(false)
		.option("--server <url>", "Shellular server URL", DEFAULT_SERVER_URL)
		.option("--dir <path>", "Working directory", os.homedir())
		.option(
			"--unknown-clients <policy>",
			`unknown clients approval policy (${NEW_CLIENT_APPROVAL_POLICIES.join(", ")})`,
			parseNewClientApprovalPolicy,
			DEFAULT_NEW_CLIENT_APPROVAL_POLICY,
		)
		.option(
			"--install-vs-plugin",
			"Install the VS Code extension to access GitHub Copilot",
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
		};
	};

	program
		.command("start")
		.description("Start Shellular in the background as a daemon")
		.action(async (options: Partial<DaemonOptions>, command: Command) => {
			await startDaemon(resolveDaemonOptions(options, command));
		});

	program
		.command("stop")
		.description("Stop the Shellular daemon")
		.action(async () => {
			await stopDaemon();
		});

	program
		.command("logs")
		.description("Stream Shellular daemon logs")
		.action(async () => {
			await showDaemonLogs();
		});

	program
		.command("status")
		.description("Show Shellular daemon status")
		.action(async () => {
			await showDaemonStatus();
		});

	program
		.command("__daemon", { hidden: true })
		.description("Internal daemon")
		.action(async (options: Partial<DaemonOptions>, command: Command) => {
			await runCli({
				...resolveDaemonOptions(options, command),
				installVsPlugin: false,
				isDaemon: true,
			});
		});

	program
		.command("clients")
		.description("Manage client device approvals")
		.action(async () => {
			try {
				const store = readKnownClients();
				const all = Object.values(store);
				if (all.length === 0) {
					logger.log("No known clients yet.");
					return;
				}

				const choices = all.map((c) => ({
					name: `${chalk.blueBright(c.clientId)}
    - ${formatClientDeviceInfo(c)}
    - ${chalk.gray(`App v${c.appVersion}`)}. ${chalk.gray(`first seen: ${new Date(c.firstSeen).toLocaleString()}`)}`,
					value: c.clientId,
					checked: c.approved,
				}));

				const approvedIds = await checkbox({
					message:
						"Select clients to approve (space to toggle, enter to save):",
					choices,
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

async function runCli({
	server,
	dir,
	installVsPlugin,
	unknownClients: unknownClientsApproval,
	isDaemon = false,
}: RunCliOptions): Promise<void> {
	if (installVsPlugin) {
		await installVsCodeExtension();
		return;
	}

	const serverUrl = new ServerUrl(server);
	const workDir = path.resolve(dir);

	ensureSingleInstance({
		serverUrl: serverUrl.toWebSocketUrl(),
		workDir,
	});

	const hostId = await getOrRegisterHostId(serverUrl);
	await initEncryption();

	const line = chalk.gray("─".repeat(34));
	const label = (key: string, value: string) =>
		`${chalk.gray(key.padEnd(17))} ${chalk.white(value)}`;

	logger.log();
	logger.log(chalk.bold.cyan(`Shellular CLI v${packageJson.version}`));
	logger.log(line);
	logger.log(label("Server:", chalk.underline(serverUrl.toWebSocketUrl())));
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
		logger.log(label("Platform:", os.platform()));
		logger.log(label("Host:", os.hostname()));
	}

	logger.log();

	const hostInfo: HostInfo = {
		id: hostId,
		username: config.USERNAME,
		hostname: os.hostname(),
		platform: os.platform(),
		dir: workDir,
		machineId: config.MACHINE_ID,
	};

	const aiManager = new AiManager();
	const availableBackends = await aiManager.init();

	const cleanup = () => {
		logger.log("Cleaning up resources...");
		stopCaffeinate();
		releaseBootLock();
		aiManager.destroy();
	};

	process.on("SIGINT", cleanup); // Ctrl+C
	process.on("SIGTERM", cleanup); // kill / docker stop
	process.on("beforeExit", cleanup);

	process.on("uncaughtException", (err) => {
		logger.error(err);
		cleanup();
		process.exit(1);
	});

	process.on("unhandledRejection", (err) => {
		logger.error(err);
		cleanup();
		process.exit(1);
	});

	startCaffeinate();

	connectWithReconnect(
		serverUrl.toWebSocketUrl(),
		hostInfo,
		async (conn, isFirst) => {
			try {
				updateBootLock({ connectionId: conn.sessionId });
				cleanupProxy();

				if (isFirst) {
					// Display QR code with hostId:e2eeKey for out-of-band key exchange
					const qrData = `${hostId}:${getKeyBase64()}`;
					logger.log();
					qrcode.generate(qrData, { small: true }, (qr: string) => {
						logger.log(chalk.dim("Install the Shellular app:"));
						logger.log(chalk.cyan.underline(APP_URL));
						logger.log();

						qr.split("\n").forEach((line) => {
							logger.log(line);
						});

						logger.log();
						logger.log(
							"📲",
							`Scan the QR code with ${chalk.bold("Shellular app")} to connect.`,
						);
						logger.log("🔒", chalk.green("Messages are end-to-end encrypted."));
						logger.log("👋", chalk.dim("Press Ctrl+C to exit.\n"));
					});
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
				initAiHandler(conn, aiManager);

				const pushStateToExtension = () => {
					notifyExtensionCliInfo({
						version: packageJson.version,
						hostname: os.hostname(),
						platform: os.platform(),
						workDir,
						sessionId: conn.sessionId,
					});
					notifyExtensionClientsSnapshot(conn.getConnectedClients());
				};
				pushStateToExtension();
				const snapshotTimer = setInterval(pushStateToExtension, 5_000);

				conn.on(MsgType.SESSION_ERROR, (data) => {
					logger.error(
						chalk.red(`✗ Connection error: ${data.error ?? "Unknown error"}`),
					);
				});

				conn.on(
					MsgType.SESSION_CLIENT_JOIN,
					async (msg: SessionClientJoinMsg) => {
						const { clientId } = msg.data;

						const deviceSummary = formatClientDeviceInfo(msg.data);

						const approval = getClientApproval(clientId);
						if (approval === true) {
							// Previously approved — auto-allow silently
							conn.send({
								type: MsgType.SESSION_CLIENT_JOIN_RESULT,
								data: { clientId, approved: true },
							});
							return;
						}

						if (approval === false) {
							// Previously rejected — silently reject again without notifying
							conn.send({
								type: MsgType.SESSION_CLIENT_JOIN_RESULT,
								data: { clientId, approved: false },
							});
							return;
						}

						// approval === null means that it's a new and unknown client

						if (unknownClientsApproval === "always-allow") {
							conn.send({
								type: MsgType.SESSION_CLIENT_JOIN_RESULT,
								data: { clientId, approved: true },
							});
							return;
						}

						if (unknownClientsApproval === "always-reject") {
							conn.send({
								type: MsgType.SESSION_CLIENT_JOIN_RESULT,
								data: { clientId, approved: false },
							});
							return;
						}

						// Record as pending/unapproved
						upsertClient(msg.data, false);

						notify({
							title: "Shellular Client Approval",
							body: [
								`Client ${clientId} (${deviceSummary}) is requesting to connect.`,
								isDaemon
									? "Run `npx shellular clients` to manage approvals."
									: "Approve or reject the connection in the terminal.",
							].join("\n"),
						});

						if (!isDaemon) {
							// Foreground: ask the user interactively
							const allow = await confirmWrapper(
								`Allow ${chalk.cyan(clientId)} (${deviceSummary}) to connect?`,
							);
							if (allow) {
								upsertClient(msg.data, true);
								conn.send({
									type: MsgType.SESSION_CLIENT_JOIN_RESULT,
									data: { clientId, approved: true },
								});
							} else {
								conn.send({
									type: MsgType.SESSION_CLIENT_JOIN_RESULT,
									data: { clientId, approved: false },
								});
							}
						} else {
							// Daemon: auto-reject, instruct user to run shellular clients
							conn.send({
								type: MsgType.SESSION_CLIENT_JOIN_RESULT,
								data: { clientId, approved: false },
							});
							logger.warn(
								`Unknown client ${clientId} (${deviceSummary}) tried to connect. Run \`${chalk.cyan("npx shellular clients")}\` to approve.`,
							);
						}
					},
				);

				conn.on("disconnected", () => {
					clearInterval(snapshotTimer);
					notifyExtensionClientsSnapshot([]);
				});

				conn.on(MsgType.SESSION_CLIENT_JOINED, (msg) => {
					upsertClient(
						{
							clientId: msg.data.clientId,
							hostId: msg.data.hostId,
							appVersion: msg.data.appVersion,
							platform: msg.data.platform,
							deviceModel: msg.data.deviceModel,
							deviceIsEmulator: msg.data.deviceIsEmulator,
							deviceManufacturer: msg.data.deviceManufacturer,
						},
						true,
					);
					const deviceSummary = formatClientDeviceInfo(msg.data);
					notify({
						title: "Shellular Client Connected",
						body: `Client ${msg.data.clientId} connected on ${deviceSummary} (${msg.data.platform}, v${msg.data.appVersion}).`,
					});

					logger.log(
						chalk.green(
							`✓ Client ${msg.data.clientId} connected on ${new Date().toLocaleString()}`,
						),
					);
					logger.log(`  - ${chalk.green("Device:")} ${deviceSummary}`);
					logger.log(
						`  - ${chalk.green("App Version:")} v${msg.data.appVersion}\n`,
					);
					notifyExtensionClientPresence(
						msg.data.clientId,
						true,
						msg.data.platform,
						msg.data.appVersion,
					);
					pushStateToExtension();

					// let the client know which AI backends are available
					const availableAIBackendsMsg: AiAvailabilityResultMsg = {
						type: MsgType.AI_AVAILABILITY_RESULT,
						clientId: msg.data.clientId,
						data: { backends: availableBackends },
					};
					conn.send(availableAIBackendsMsg);
				});

				conn.on(MsgType.SESSION_CLIENT_LEFT, (data: SessionClientLeftMsg) => {
					logger.log(
						chalk.red(
							`✗ Client ${data.data.clientId} disconnected on ${new Date().toLocaleString()}`,
						),
					);
					notifyExtensionClientPresence(data.data.clientId, false);
					pushStateToExtension();
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
		checkForUpdate(packageJson.version).catch(() => {});
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

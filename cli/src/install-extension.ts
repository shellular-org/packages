import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import chalk from "chalk";

import { config } from "./config";
import { buildVsix, resolveVsixPath } from "./extension-package";
import { logger } from "./logger";

const EXTENSION_ID = "io.foxbiz.shellular";

// ─── Binary discovery ─────────────────────────────────────────────────────────

interface CodeBinary {
	execPath: string;
	isInsiders: boolean;
}

function probe(p: string): string | null {
	try {
		if (fs.existsSync(p)) return p;
	} catch {
		// ignore
	}
	return null;
}

function findCodeBinary(): CodeBinary | null {
	const platform = os.platform();

	// 1. Try PATH first
	try {
		const which = platform === "win32" ? "where" : "which";
		const result = execSync(`${which} code`, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		})
			.trim()
			.split("\n")[0]
			.trim();
		if (result && fs.existsSync(result)) {
			return { execPath: result, isInsiders: false };
		}
	} catch {
		// not on PATH
	}

	// Also try code-insiders on PATH
	try {
		const which = platform === "win32" ? "where" : "which";
		const result = execSync(`${which} code-insiders`, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		})
			.trim()
			.split("\n")[0]
			.trim();
		if (result && fs.existsSync(result)) {
			return { execPath: result, isInsiders: true };
		}
	} catch {
		// not on PATH
	}

	// 2. Platform-specific fallbacks
	if (platform === "darwin") {
		const candidates: Array<[string, boolean]> = [
			[
				"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
				false,
			],
			["/opt/homebrew/bin/code", false],
			["/usr/local/bin/code", false],
			[
				"/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders",
				true,
			],
			["/opt/homebrew/bin/code-insiders", true],
		];
		for (const [p, isInsiders] of candidates) {
			if (probe(p)) return { execPath: p, isInsiders };
		}
	} else if (platform === "linux") {
		const candidates: Array<[string, boolean]> = [
			["/usr/bin/code", false],
			["/snap/bin/code", false],
			["/usr/bin/code-insiders", true],
			["/snap/bin/code-insiders", true],
		];
		for (const [p, isInsiders] of candidates) {
			if (probe(p)) return { execPath: p, isInsiders };
		}
	} else if (platform === "win32") {
		const localAppData =
			process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
		const candidates: Array<[string, boolean]> = [
			[
				path.join(
					localAppData,
					"Programs",
					"Microsoft VS Code",
					"bin",
					"code.cmd",
				),
				false,
			],
			[
				path.join(
					"C:",
					"Program Files",
					"Microsoft VS Code",
					"bin",
					"code.cmd",
				),
				false,
			],
			[
				path.join(
					localAppData,
					"Programs",
					"Microsoft VS Code Insiders",
					"bin",
					"code-insiders.cmd",
				),
				true,
			],
		];
		for (const [p, isInsiders] of candidates) {
			if (probe(p)) return { execPath: p, isInsiders };
		}
	}

	return null;
}

// ─── Extension check / install ────────────────────────────────────────────────

function isExtensionInstalled(binary: CodeBinary): boolean {
	try {
		const args = ["--list-extensions"];
		const output = execFileSync(binary.execPath, args, {
			encoding: "utf-8",
			timeout: 10_000,
			env: buildEnv(binary),
			...(os.platform() === "win32" ? { shell: true } : {}),
		});

		console.log(output);

		return output
			.toLowerCase()
			.split("\n")
			.some((line) => line.trim() === EXTENSION_ID.toLowerCase());
	} catch {
		return false;
	}
}

function buildEnv(binary: CodeBinary): NodeJS.ProcessEnv {
	const binDir = path.dirname(binary.execPath);
	return {
		...process.env,
		PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
	};
}

function confirm(question: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer.trim().toLowerCase().startsWith("y"));
		});
	});
}

export async function installVsCodeExtension(): Promise<void> {
	logger.log(chalk.bold.cyan("Shellular VS Code Extension Installer"));
	logger.log(chalk.gray("─".repeat(40)));

	// 1. Find the code binary
	const binary = findCodeBinary();
	if (!binary) {
		logger.log(
			chalk.red(
				"✗ Could not find the VS Code CLI (`code` binary) on this machine.",
			),
		);
		logger.log(
			chalk.gray(
				"  Open VS Code, run the command: Shell Command: Install 'code' command in PATH",
			),
		);
		process.exit(1);
	}

	logger.log(
		chalk.gray("Found VS Code binary:"),
		chalk.white(binary.execPath),
		binary.isInsiders ? chalk.yellow("(Insiders)") : "",
	);

	// 2. Check install state (we still continue for upgrade)
	if (!config.SHELLULAR_DEV && isExtensionInstalled(binary)) {
		logger.log(chalk.yellow(`Extension ${EXTENSION_ID} is already installed`));
		return;
	}

	// 3. Find or build the .vsix
	let vsixPath: string | null = null;

	vsixPath = resolveVsixPath();

	if (!vsixPath) {
		if (config.SHELLULAR_DEV) {
			try {
				vsixPath = buildVsix();
			} catch (err) {
				logger.log(
					chalk.red("✗ Build failed:"),
					err instanceof Error ? err.message : String(err),
				);
				process.exit(1);
			}
		} else {
			logger.log(chalk.red("✗ No .vsix file found in the installed package."));
			logger.log(
				chalk.gray(
					"  This shouldn't happen — please reinstall shellular or report the issue.",
				),
			);
			process.exit(1);
		}
	}

	logger.log(chalk.gray("Extension package:"), chalk.white(vsixPath));
	logger.log();

	// 4. Confirm with user
	const ok = await confirm(
		chalk.yellow(
			`Install the Shellular VS Code extension (${EXTENSION_ID})? [y/N] `,
		),
	);
	if (!ok) {
		logger.log(chalk.gray("Installation cancelled."));
		return;
	}

	// 5. Run install
	logger.log();
	logger.log(chalk.cyan("Installing extension…"));
	try {
		const spawnOptions: Parameters<typeof execFileSync>[2] = {
			stdio: "inherit",
			timeout: 60_000,
			env: buildEnv(binary),
			...(os.platform() === "win32" ? { shell: true } : {}),
		};
		execFileSync(
			binary.execPath,
			["--install-extension", vsixPath, "--force"],
			spawnOptions,
		);
	} catch (err) {
		logger.log(
			chalk.red("✗ Installation failed:"),
			err instanceof Error ? err.message : String(err),
		);
		process.exit(1);
	}

	// 6. Verify
	if (isExtensionInstalled(binary)) {
		logger.log();
		logger.log(chalk.green(`✓ Extension installed successfully!`));
		logger.log(
			chalk.gray(
				"  Reload VS Code (Ctrl+Shift+P → Developer: Reload Window) to activate it.",
			),
		);
	} else {
		logger.log(
			chalk.yellow(
				"⚠ Installation command succeeded but extension was not found in --list-extensions.",
			),
		);
		logger.log(
			chalk.gray("  Try reloading VS Code and running this command again."),
		);
	}
}

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import chalk from "chalk";

import packageJson from "../package.json";
import { config } from "./config";
import { logger } from "./logger";

const filename =
	typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url);
const dirname =
	typeof __dirname === "string" ? __dirname : path.dirname(filename);

function packageVersion(): string {
	return (packageJson as { version: string }).version;
}

function vsixFileNames(): string[] {
	return [`shellular-${packageVersion()}.vsix`, "shellular.vsix"];
}

export function extensionRoots(): string[] {
	return [
		// production: packaged .vsix bundled inside dist/
		dirname,
		// production: historical location next to dist/
		path.join(dirname, ".."),
		// dev: extension is expected to be a sibling project
		path.join(dirname, "..", "vscode-extension"),
		// parent of vscode-extension/ (historical .vsix output location)
		path.join(dirname, ".."),
		// also try relative to cwd
		path.join(process.cwd(), "vscode-extension"),
		path.join(process.cwd(), "vscode-extension"),
		path.join(process.cwd()),
	];
}

export function resolveVsixPath(): string | null {
	for (const root of extensionRoots()) {
		for (const name of vsixFileNames()) {
			const candidate = path.join(root, name);
			if (fs.existsSync(candidate)) return candidate;
		}
	}

	return null;
}

export function removeExistingVsixFiles(
	roots: string[] = extensionRoots(),
): number {
	let removed = 0;

	for (const root of roots) {
		for (const name of vsixFileNames()) {
			const candidate = path.join(root, name);
			try {
				if (fs.existsSync(candidate)) {
					fs.unlinkSync(candidate);
					removed += 1;
				}
			} catch {
				// best-effort cleanup
			}
		}
	}

	return removed;
}

export function findExtensionSourceDir(): string | null {
	for (const root of extensionRoots()) {
		const pkgJson = path.join(root, "package.json");
		if (!fs.existsSync(pkgJson)) continue;

		try {
			const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf-8")) as {
				name?: string;
			};
			if (pkg.name === "shellular") return root;
		} catch {
			// ignore malformed package.json files outside our control
		}
	}

	return null;
}

export function buildVsix(): string {
	logger.log(
		chalk.cyan(`Building VS Code extension in ${config.EXT_SRC_DIR}…`),
	);

	fs.mkdirSync(config.EXT_OUT_DIR, { recursive: true });
	removeExistingVsixFiles([config.EXT_OUT_DIR]);

	logger.log(chalk.gray("  Installing extension dependencies…"));
	execFileSync("pnpm", ["install", "--prefer-offline", "--ignore-workspace"], {
		cwd: config.EXT_SRC_DIR,
		stdio: "inherit",
		timeout: 120_000,
	});

	execFileSync("pnpm", ["approve-builds", "--all"], {
		cwd: config.EXT_SRC_DIR,
		stdio: "inherit",
		timeout: 120_000,
	});

	logger.log(chalk.gray("  Compiling TypeScript…"));
	execFileSync("pnpm", ["run", "compile"], {
		cwd: config.EXT_SRC_DIR,
		stdio: "inherit",
		timeout: 60_000,
	});

	const outPath = path.join(config.EXT_OUT_DIR, "shellular.vsix");
	logger.log(chalk.gray("  Packaging .vsix…"));
	execFileSync("pnpm", ["exec", "vsce", "package", "--out", outPath], {
		cwd: config.EXT_SRC_DIR,
		stdio: "inherit",
		timeout: 60_000,
	});

	if (!fs.existsSync(outPath)) {
		throw new Error(`vsce ran but .vsix not found at ${outPath}`);
	}

	return outPath;
}

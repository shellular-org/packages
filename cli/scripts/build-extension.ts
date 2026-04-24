import chalk from "chalk";

import { buildVsix } from "@/extension-package";
import { logger } from "@/logger";

async function main(): Promise<void> {
	const vsixPath = buildVsix();
	logger.log(chalk.green(`VS Code extension packaged at ${vsixPath}`));
}

main().catch((err) => {
	process.stderr.write(`${String(err)}\n`);
	process.exit(1);
});

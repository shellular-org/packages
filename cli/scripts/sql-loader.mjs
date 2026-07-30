/**
 * Node module-customization hook that loads `.sql` files as string modules.
 *
 * The published bundle gets this from tsup (`loader: { ".sql": "text" }`), but
 * anything running from source goes through Node/tsx, which has no `.sql`
 * handling and fails with ERR_UNKNOWN_FILE_EXTENSION. Registering this keeps
 * `import sql from "./x.sql"` meaning the same thing in both layouts.
 *
 * Used by `pnpm dev`, `pnpm start`, and the schema generator via
 * `tsx --loader ./scripts/sql-loader.mjs`.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
	if (specifier.endsWith(".sql")) {
		// Resolve relative to the importing module; Node's default resolver
		// rejects unknown extensions before we ever see them in `load`.
		const url = new URL(
			specifier,
			context.parentURL ?? pathToFileURL(`${process.cwd()}/`),
		).href;
		return { url, format: "sql", shortCircuit: true };
	}
	return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
	if (context.format === "sql" || url.endsWith(".sql")) {
		const sql = await readFile(fileURLToPath(url), "utf-8");
		return {
			format: "module",
			shortCircuit: true,
			source: `export default ${JSON.stringify(sql)};`,
		};
	}
	return nextLoad(url, context);
}

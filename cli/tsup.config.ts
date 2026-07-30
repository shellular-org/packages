import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/main.ts"],
	format: ["cjs", "esm"], // Build for commonJS and ESmodules
	dts: true, // Generate declaration file (.d.ts)
	splitting: false,
	sourcemap: false,
	minify: true,
	clean: true,
	// Inline `.sql` migrations into the bundle as strings. Nothing is read from
	// disk at runtime: `__dirname` is unreliable across npx / global / local
	// installs, and only `dist/` ships to npm.
	loader: { ".sql": "text" },
});

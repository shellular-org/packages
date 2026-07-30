/**
 * `.sql` files are imported as strings. At build time tsup inlines them via
 * `loader: { ".sql": "text" }`; under tsx/tsc this declaration is what makes
 * the import type-check. Nothing reads SQL from disk at runtime.
 */
declare module "*.sql" {
	const sql: string;
	export default sql;
}

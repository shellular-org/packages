/**
 * Registers the `.sql` module hook (see `sql-loader.mjs`) for processes running
 * from source. Used via `tsx --import ./scripts/register-sql-loader.mjs` —
 * the non-deprecated form of `--loader`.
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./sql-loader.mjs", pathToFileURL(`${import.meta.dirname}/`));

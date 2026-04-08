/**
 * libSQL runtime adapter
 *
 * Creates a Kysely dialect for libSQL/Turso.
 * Loaded at runtime via virtual module.
 */

import type { Dialect } from "kysely";

import type { LibsqlConfig } from "./adapters.js";
import { wrapWithLazyMigrations } from "./lazy-migrations.js";

/**
 * Create a libSQL dialect from config
 */
export function createDialect(config: LibsqlConfig): Dialect {
	// Dynamic import to avoid loading @libsql/kysely-libsql at config time
	const { LibsqlDialect } = require("@libsql/kysely-libsql");

	return wrapWithLazyMigrations(
		new LibsqlDialect({
			url: config.url,
			authToken: config.authToken,
		}),
	);
}

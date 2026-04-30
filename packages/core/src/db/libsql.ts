/**
 * libSQL runtime adapter
 *
 * Creates a Kysely dialect for libSQL/Turso.
 * Loaded at runtime via virtual module.
 */

import { LibsqlDialect } from "@libsql/kysely-libsql";
import type { Dialect } from "kysely";

import type { LibsqlConfig } from "./adapters.js";

/**
 * Create a libSQL dialect from config
 */
export function createDialect(config: LibsqlConfig): Dialect {
	return new LibsqlDialect({
		url: config.url,
		authToken: config.authToken,
	});
}

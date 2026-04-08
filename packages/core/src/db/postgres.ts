/**
 * PostgreSQL runtime adapter
 *
 * Creates a Kysely dialect for PostgreSQL via pg.
 * Loaded at runtime via virtual module.
 */

import type { Dialect } from "kysely";
import { PostgresDialect } from "kysely";
import { Pool } from "pg";

import type { PostgresConfig } from "./adapters.js";
import { wrapWithLazyMigrations } from "./lazy-migrations.js";

/**
 * Create a PostgreSQL dialect from config
 */
export function createDialect(config: PostgresConfig): Dialect {
	const pool = new Pool({
		connectionString: config.connectionString,
		host: config.host,
		port: config.port,
		database: config.database,
		user: config.user,
		password: config.password,
		ssl: config.ssl,
		min: config.pool?.min ?? 0,
		max: config.pool?.max ?? 10,
	});

	return wrapWithLazyMigrations(new PostgresDialect({ pool }));
}

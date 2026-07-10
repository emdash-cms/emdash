/**
 * PostgreSQL runtime adapter
 *
 * Creates a Kysely dialect for PostgreSQL via pg.
 * Loaded at runtime via virtual module.
 */

import type { PostgresDialect } from "kysely";
import { Pool } from "pg";

import { FailFastPostgresDialect } from "../database/pg-migration-lock.js";
import type { PostgresConfig } from "./adapters.js";

/**
 * Create a PostgreSQL dialect from config
 */
export function createDialect(config: PostgresConfig): PostgresDialect {
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

	// Fail-fast migration locking instead of Kysely's blocking advisory
	// lock — see pg-migration-lock.ts (#1744).
	return new FailFastPostgresDialect({ pool });
}

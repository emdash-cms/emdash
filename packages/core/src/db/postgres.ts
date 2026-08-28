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
		// Left undefined when unset, which preserves node-postgres's own
		// defaults rather than imposing new ones.
		connectionTimeoutMillis: config.pool?.connectionTimeoutMillis,
		idleTimeoutMillis: config.pool?.idleTimeoutMillis,
	});

	// node-postgres emits `error` on the pool for a fault raised on an IDLE
	// client — a managed-database failover is the common cause. That is an
	// EventEmitter `error` event, so with no listener attached Node throws and
	// the server process exits. The pool itself recovers: pg discards the bad
	// client. Logging is therefore the whole handler.
	pool.on("error", (error) => {
		console.error("[emdash] idle Postgres client error; the pool discarded it", error);
	});

	// Fail-fast migration locking instead of Kysely's blocking advisory
	// lock — see pg-migration-lock.ts (#1744).
	return new FailFastPostgresDialect({ pool });
}

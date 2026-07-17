import { Kysely, SqliteDialect } from "kysely";

import { openNodeSqliteDatabase } from "../db/node-sqlite-compat.js";
import { EmDashDatabaseError } from "./errors.js";
import { kyselyLogOption } from "./instrumentation.js";
import type { Database } from "./types.js";

export { EmDashDatabaseError };

export interface DatabaseConfig {
	url: string;
	authToken?: string;
}

/**
 * Creates a Kysely database instance
 * Supports:
 * - file:./path/to/db.sqlite (local SQLite)
 * - :memory: (in-memory SQLite for testing)
 * - libsql://... (Turso/libSQL with auth token) - TODO
 */
export function createDatabase(config: DatabaseConfig): Kysely<Database> {
	try {
		// Handle file-based SQLite
		if (config.url.startsWith("file:") || config.url === ":memory:") {
			const dbPath = config.url === ":memory:" ? ":memory:" : config.url.replace("file:", "");

			const sqlite = openNodeSqliteDatabase(dbPath);

			// Enable WAL mode for crash safety — writes go to a write-ahead log
			// before being applied, preventing FTS5 shadow table corruption on
			// process kill during content writes. No-op for :memory: databases.
			sqlite.pragma("journal_mode = WAL");

			// Enable foreign key constraints
			sqlite.pragma("foreign_keys = ON");

			const dialect = new SqliteDialect({
				database: sqlite,
			});

			return new Kysely<Database>({ dialect, log: kyselyLogOption() });
		}

		// Handle libSQL (Turso)
		if (config.url.startsWith("libsql:")) {
			if (!config.authToken) {
				throw new EmDashDatabaseError("Auth token required for remote libSQL database");
			}
			// LibSQL implementation would use @libsql/kysely-libsql
			throw new EmDashDatabaseError("LibSQL not yet implemented");
		}

		throw new EmDashDatabaseError(`Unsupported database URL scheme: ${config.url}`);
	} catch (error) {
		if (error instanceof EmDashDatabaseError) {
			throw error;
		}
		throw new EmDashDatabaseError("Failed to create database", error);
	}
}

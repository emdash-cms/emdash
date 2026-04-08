/**
 * SQLite runtime adapter
 *
 * Creates a Kysely dialect for better-sqlite3.
 * Loaded at runtime via virtual module.
 */

import type { Dialect } from "kysely";

import type { SqliteConfig } from "./adapters.js";
import { wrapWithLazyMigrations } from "./lazy-migrations.js";

/**
 * Create a SQLite dialect from config
 */
export function createDialect(config: SqliteConfig): Dialect {
	// Dynamic import to avoid loading better-sqlite3 at config time
	const BetterSqlite3 = require("better-sqlite3");
	const { SqliteDialect } = require("kysely");

	// Parse URL to get file path
	const url = config.url;
	const filePath = url.startsWith("file:") ? url.slice(5) : url;

	const database = new BetterSqlite3(filePath);

	return wrapWithLazyMigrations(new SqliteDialect({ database }));
}

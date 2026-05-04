/**
 * SQLite runtime adapter
 *
 * Creates a Kysely dialect for better-sqlite3.
 * Loaded at runtime via virtual module.
 */

import BetterSqlite3 from "better-sqlite3";
import { type Dialect, SqliteDialect } from "kysely";

import type { SqliteConfig } from "./adapters.js";

/**
 * Create a SQLite dialect from config
 */
export function createDialect(config: SqliteConfig): Dialect {
	// Parse URL to get file path
	const url = config.url;
	const filePath = url.startsWith("file:") ? url.slice(5) : url;

	const database = new BetterSqlite3(filePath);

	return new SqliteDialect({ database });
}

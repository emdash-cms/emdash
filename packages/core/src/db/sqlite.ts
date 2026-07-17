/**
 * SQLite runtime adapter
 *
 * Creates a Kysely dialect for node:sqlite (via a better-sqlite3-compatible
 * wrapper — see node-sqlite-compat.ts). No native compiled dependency.
 * Loaded at runtime via virtual module.
 */

import { type Dialect, SqliteDialect } from "kysely";

import type { SqliteConfig } from "./adapters.js";
import { openNodeSqliteDatabase } from "./node-sqlite-compat.js";

/**
 * Create a SQLite dialect from config
 */
export function createDialect(config: SqliteConfig): Dialect {
	// Parse URL to get file path
	const url = config.url;
	const filePath = url.startsWith("file:") ? url.slice(5) : url;

	const database = openNodeSqliteDatabase(filePath);

	return new SqliteDialect({ database });
}

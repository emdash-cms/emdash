/**
 * Dialect-specific SQL helpers
 *
 * Every function takes a Kysely `db` instance and detects the dialect from
 * the adapter class. No module-level state, no globals, no heuristics —
 * the adapter is the source of truth.
 *
 * This is NOT an ORM abstraction — just targeted helpers for the ~15 places
 * that use raw dialect-specific SQL. Most Kysely schema builder code already
 * works cross-dialect.
 */

import type { ColumnDataType, Kysely, RawBuilder } from "kysely";
import { sql } from "kysely";

import type { DatabaseDialectType } from "../db/adapters.js";
import type { Database } from "./types.js";

export type { DatabaseDialectType };

/**
 * Detect dialect type from a Kysely instance via the adapter class name.
 */
export function detectDialect(db: Kysely<Database>): DatabaseDialectType {
	const name = db.getExecutor().adapter.constructor.name;
	if (name === "PostgresAdapter") return "postgres";
	return "sqlite";
}

export function isSqlite(db: Kysely<Database>): boolean {
	return detectDialect(db) === "sqlite";
}

export function isPostgres(db: Kysely<Database>): boolean {
	return detectDialect(db) === "postgres";
}

/**
 * Default timestamp expression for column defaults.
 * Wrapped in parens for use in CREATE TABLE ... DEFAULT (...).
 *
 * sqlite:   (datetime('now'))
 * postgres: CURRENT_TIMESTAMP
 */
export function currentTimestamp(db: Kysely<Database>): RawBuilder<string> {
	if (isPostgres(db)) {
		return sql`CURRENT_TIMESTAMP`;
	}
	return sql`(datetime('now'))`;
}

/**
 * Timestamp expression for use in WHERE clauses and SET expressions.
 * No wrapping parens.
 *
 * sqlite:   datetime('now')
 * postgres: CURRENT_TIMESTAMP
 */
export function currentTimestampValue(db: Kysely<Database>): RawBuilder<string> {
	if (isPostgres(db)) {
		return sql`CURRENT_TIMESTAMP`;
	}
	return sql`datetime('now')`;
}

/**
 * Check if a table exists in the database.
 */
export async function tableExists(db: Kysely<Database>, tableName: string): Promise<boolean> {
	if (isPostgres(db)) {
		const result = await sql<{ exists: boolean }>`
			SELECT EXISTS(
				SELECT 1 FROM information_schema.tables
				WHERE table_schema = 'public' AND table_name = ${tableName}
			) as exists
		`.execute(db);
		return result.rows[0]?.exists === true;
	}

	const result = await sql<{ name: string }>`
		SELECT name FROM sqlite_master
		WHERE type = 'table' AND name = ${tableName}
	`.execute(db);
	return result.rows.length > 0;
}

/**
 * List tables matching a LIKE pattern.
 */
export async function listTablesLike(db: Kysely<Database>, pattern: string): Promise<string[]> {
	if (isPostgres(db)) {
		const result = await sql<{ table_name: string }>`
			SELECT table_name FROM information_schema.tables
			WHERE table_schema = 'public' AND table_name LIKE ${pattern}
		`.execute(db);
		return result.rows.map((r) => r.table_name);
	}

	const result = await sql<{ name: string }>`
		SELECT name FROM sqlite_master
		WHERE type = 'table' AND name LIKE ${pattern}
	`.execute(db);
	return result.rows.map((r) => r.name);
}

/**
 * Column type for binary data.
 *
 * sqlite:   blob
 * postgres: bytea
 */
export function binaryType(db: Kysely<Database>): ColumnDataType {
	if (isPostgres(db)) {
		return "bytea";
	}
	return "blob";
}

/**
 * SQL expression for extracting a field from a JSON/JSONB column.
 *
 * sqlite:   json_extract(column, '$.path')
 * postgres: column->>'path'
 */
export function jsonExtractExpr(db: Kysely<Database>, column: string, path: string): string {
	if (isPostgres(db)) {
		return `${column}->>'${path}'`;
	}
	return `json_extract(${column}, '$.${path}')`;
}

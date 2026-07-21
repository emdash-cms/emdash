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
import { validateIdentifier, validateJsonFieldName } from "./validate.js";

export type { DatabaseDialectType };

/**
 * Detect dialect type from a Kysely instance via the adapter class name.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any Kysely instance
export function detectDialect(db: Kysely<any>): DatabaseDialectType {
	const name = db.getExecutor().adapter.constructor.name;
	if (name === "PostgresAdapter") return "postgres";
	return "sqlite";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any Kysely instance
export function isSqlite(db: Kysely<any>): boolean {
	return detectDialect(db) === "sqlite";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any Kysely instance
export function isPostgres(db: Kysely<any>): boolean {
	return detectDialect(db) === "postgres";
}

/**
 * Default timestamp expression for column defaults.
 * Wrapped in parens for use in CREATE TABLE ... DEFAULT (...).
 *
 * sqlite:   (datetime('now'))
 * postgres: CURRENT_TIMESTAMP
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any Kysely instance
export function currentTimestamp(db: Kysely<any>): RawBuilder<string> {
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any Kysely instance
export function currentTimestampValue(db: Kysely<any>): RawBuilder<string> {
	if (isPostgres(db)) {
		return sql`CURRENT_TIMESTAMP`;
	}
	return sql`datetime('now')`;
}

/**
 * Build WHERE clause for status filtering on a content table.
 * When filtering for 'published' status, also include scheduled content
 * whose scheduled_at time has passed (treating it as effectively published).
 *
 * Visibility is computed, not flipped by cron, so a literal
 * `status = 'published'` comparison undercounts scheduled-and-due entries —
 * every "publicly visible" filter must go through this helper.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any Kysely instance
export function buildStatusCondition(
	db: Kysely<any>,
	status: string,
	tablePrefix?: string,
): ReturnType<typeof sql> {
	const statusField = tablePrefix ? `${tablePrefix}.status` : "status";
	const scheduledAtField = tablePrefix ? `${tablePrefix}.scheduled_at` : "scheduled_at";

	if (status === "published") {
		// Include both published content AND scheduled content past its publish time.
		// scheduled_at is stored as text (ISO 8601). On Postgres, we must cast it
		// to timestamptz for the comparison with CURRENT_TIMESTAMP to work.
		const scheduledAtExpr = isPostgres(db)
			? sql`${sql.ref(scheduledAtField)}::timestamptz`
			: sql.ref(scheduledAtField);
		const nowExpr = isPostgres(db)
			? currentTimestampValue(db)
			: sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
		return sql`(${sql.ref(statusField)} = 'published' OR (${sql.ref(statusField)} = 'scheduled' AND ${scheduledAtExpr} <= ${nowExpr}))`;
	}

	return sql`${sql.ref(statusField)} = ${status}`;
}

/**
 * Check if a table exists in the database.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any Kysely instance
export async function tableExists(db: Kysely<any>, tableName: string): Promise<boolean> {
	if (isPostgres(db)) {
		// Scope to the active schema (matches indexExists/columnExists below).
		// Hardcoding 'public' breaks non-public-schema Postgres deployments.
		const result = await sql<{ exists: boolean }>`
			SELECT EXISTS(
				SELECT 1 FROM information_schema.tables
				WHERE table_schema = current_schema() AND table_name = ${tableName}
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
 * Check if an index exists in the database.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any Kysely instance
export async function indexExists(db: Kysely<any>, indexName: string): Promise<boolean> {
	if (isPostgres(db)) {
		const result = await sql<{ exists: boolean }>`
			SELECT EXISTS(
				SELECT 1 FROM pg_indexes
				WHERE schemaname = current_schema() AND indexname = ${indexName}
			) as exists
		`.execute(db);
		return result.rows[0]?.exists === true;
	}

	const result = await sql<{ name: string }>`
		SELECT name FROM sqlite_master
		WHERE type = 'index' AND name = ${indexName}
	`.execute(db);
	return result.rows.length > 0;
}

/**
 * Check if a column exists in the database.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any Kysely instance
export async function columnExists(
	db: Kysely<any>,
	tableName: string,
	columnName: string,
): Promise<boolean> {
	if (isPostgres(db)) {
		const result = await sql<{ exists: boolean }>`
			SELECT EXISTS(
				SELECT 1 FROM information_schema.columns
				WHERE table_schema = current_schema()
					AND table_name = ${tableName}
					AND column_name = ${columnName}
			) as exists
		`.execute(db);
		return result.rows[0]?.exists === true;
	}

	const result = await sql<{ name: string }>`
		SELECT name FROM pragma_table_info(${tableName})
		WHERE name = ${columnName}
	`.execute(db);
	return result.rows.length > 0;
}

/**
 * List tables matching a LIKE pattern.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any Kysely instance
export async function listTablesLike(db: Kysely<any>, pattern: string): Promise<string[]> {
	if (isPostgres(db)) {
		// Scope to the connection's active schema rather than hardcoding
		// 'public'. A Postgres deployment using a non-public schema (per-tenant
		// or shared-cluster setups), or per-test schemas, otherwise sees tables
		// from the wrong schema — or none at all. Mirrors migration 038.
		const result = await sql<{ table_name: string }>`
			SELECT table_name FROM information_schema.tables
			WHERE table_schema = current_schema() AND table_name LIKE ${pattern}
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any Kysely instance
export function binaryType(db: Kysely<any>): ColumnDataType {
	if (isPostgres(db)) {
		return "bytea";
	}
	return "blob";
}

/**
 * SQL expression for extracting a field from a JSON column stored as text.
 *
 * sqlite:   json_extract(column, '$.path')
 * postgres: (column)::jsonb->>'path'
 *
 * The Postgres cast is required because JSON columns (e.g.
 * `_plugin_storage.data`) are `text`, and `text ->> unknown` is not an
 * operator. The cast is immutable, so the same expression works in
 * expression indexes — queries and indexes must build it through this
 * helper so the planner can match them.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any Kysely instance
export function jsonExtractExpr(db: Kysely<any>, column: string, path: string): string {
	validateIdentifier(column, "JSON column name");
	validateJsonFieldName(path, "JSON path");
	if (isPostgres(db)) {
		return `(${column})::jsonb->>'${path}'`;
	}
	return `json_extract(${column}, '$.${path}')`;
}

/**
 * SQL expression for extracting a queryable field from the plugin-storage
 * `data` column.
 *
 * `_plugin_storage.data` is `text`, so Postgres extraction goes through the
 * `(data)::jsonb->>'field'` cast (#1898) — otherwise `text ->> unknown` is not
 * an operator. But the extracted value is still `text`, so a numeric comparison
 * (`stock >= 10`) compares lexically (`'9' >= '10'` is TRUE) and silently
 * over-counts / oversells; pass `{ numeric: true }` for a numeric comparison.
 *
 * The numeric form is a **type-guarded** cast, not a bare `::numeric`. A bare
 * cast throws `invalid input syntax for type numeric` the moment a single
 * scanned row stores a non-number in that field (documents are schemaless),
 * aborting the whole query — and it would diverge from SQLite, which silently
 * coerces. Guarding with `jsonb_typeof`/`json_type` makes the comparison total
 * and parity-correct on both dialects: a non-number stored value yields `NULL`
 * (no match) instead of an error.
 *
 * The field name is validated before interpolation, so the casts wrap only a
 * safe identifier and add no injection surface.
 *
 * sqlite text:      json_extract(data, '$.field')
 * sqlite numeric:   CASE WHEN json_type(data, '$.field') IN ('integer', 'real')
 *                     THEN json_extract(data, '$.field') END
 * postgres text:    (data)::jsonb->>'field'
 * postgres numeric: CASE WHEN jsonb_typeof((data)::jsonb->'field') = 'number'
 *                     THEN ((data)::jsonb->>'field')::numeric END
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any Kysely instance
export function pluginDataExtractExpr(
	db: Kysely<any>,
	field: string,
	options?: { numeric?: boolean },
): string {
	validateJsonFieldName(field, "plugin storage field name");
	if (isPostgres(db)) {
		const text = `(data)::jsonb->>'${field}'`;
		if (!options?.numeric) return text;
		return `CASE WHEN jsonb_typeof((data)::jsonb->'${field}') = 'number' THEN (${text})::numeric END`;
	}
	const extract = `json_extract(data, '$.${field}')`;
	if (!options?.numeric) return extract;
	return `CASE WHEN json_type(data, '$.${field}') IN ('integer', 'real') THEN ${extract} END`;
}

/**
 * SQL expression for ordering plugin-storage rows by a `data` field.
 *
 * `ORDER BY` has no bound operand to infer numeric-vs-text from, so extracting
 * as text (`->>'field'`) would sort a numeric field lexically on Postgres
 * (`[10, 100, 9]`) while SQLite's `json_extract` sorts it numerically — a
 * cross-dialect divergence. Ordering over the jsonb-native value (`->'field'`,
 * single arrow) fixes this: jsonb btree ordering is numeric among numbers,
 * lexical among strings, and total across heterogeneous values (never throws).
 * SQLite's `json_extract` already orders numerically, so it is unchanged.
 *
 * sqlite:   json_extract(data, '$.field')
 * postgres: (data)::jsonb->'field'
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any Kysely instance
export function pluginDataOrderExpr(db: Kysely<any>, field: string): string {
	validateJsonFieldName(field, "plugin storage order field name");
	if (isPostgres(db)) {
		return `(data)::jsonb->'${field}'`;
	}
	return `json_extract(data, '$.${field}')`;
}

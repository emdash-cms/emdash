/**
 * Plugin Storage Query Validation and Building
 *
 * Validates that queries only use indexed fields and builds SQL WHERE clauses.
 *
 * @see PLUGIN-SYSTEM.md § Plugin Storage > Query Validation
 */

import type { Kysely } from "kysely";

import { pluginDataExtractExpr, pluginDataOrderExpr } from "../database/dialect-helpers.js";
import type { WhereClause, WhereValue, RangeFilter, InFilter, StartsWithFilter } from "./types.js";

/**
 * Error thrown when querying non-indexed fields
 */
export class StorageQueryError extends Error {
	constructor(
		message: string,
		public field?: string,
		public suggestion?: string,
	) {
		super(message);
		this.name = "StorageQueryError";
	}
}

/**
 * Check if a value is a range filter
 */
export function isRangeFilter(value: WhereValue): value is RangeFilter {
	if (typeof value !== "object" || value === null) return false;
	return "gt" in value || "gte" in value || "lt" in value || "lte" in value;
}

/**
 * Check if a value is an IN filter
 */
export function isInFilter(value: WhereValue): value is InFilter {
	if (typeof value !== "object" || value === null) return false;
	return "in" in value && Array.isArray(value.in);
}

/**
 * Check if a value is a startsWith filter
 */
export function isStartsWithFilter(value: WhereValue): value is StartsWithFilter {
	if (typeof value !== "object" || value === null) return false;
	return "startsWith" in value && typeof value.startsWith === "string";
}

/**
 * Escape LIKE pattern metacharacters so a startsWith prefix matches
 * literally. Without this, `%` and `_` in the prefix act as wildcards
 * (e.g. `{ startsWith: "50%" }` would match "50x off").
 */
export function escapeLikePattern(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

/**
 * Get the set of indexed fields from index declarations
 */
export function getIndexedFields(indexes: Array<string | string[]>): Set<string> {
	const fields = new Set<string>();
	for (const index of indexes) {
		if (Array.isArray(index)) {
			for (const field of index) {
				fields.add(field);
			}
		} else {
			fields.add(index);
		}
	}
	return fields;
}

/**
 * Validate that all fields in a where clause are indexed
 */
export function validateWhereClause(
	where: WhereClause,
	indexedFields: Set<string>,
	pluginId: string,
	collection: string,
): void {
	for (const field of Object.keys(where)) {
		if (!indexedFields.has(field)) {
			throw new StorageQueryError(
				`Cannot query on non-indexed field '${field}'.`,
				field,
				`Add '${field}' to storage.${collection}.indexes in plugin '${pluginId}' to enable this query.`,
			);
		}
	}
}

/**
 * Validate orderBy fields are indexed
 */
export function validateOrderByClause(
	orderBy: Record<string, "asc" | "desc">,
	indexedFields: Set<string>,
	pluginId: string,
	collection: string,
): void {
	for (const field of Object.keys(orderBy)) {
		if (!indexedFields.has(field)) {
			throw new StorageQueryError(
				`Cannot order by non-indexed field '${field}'.`,
				field,
				`Add '${field}' to storage.${collection}.indexes in plugin '${pluginId}' to enable ordering by this field.`,
			);
		}
	}
}

/**
 * SQL expression for extracting a queryable field from the `_plugin_storage.data`
 * column.
 *
 * Delegates to `pluginDataExtractExpr`, which validates the field name before
 * interpolation and applies the dialect-correct extraction: a `::jsonb` cast on
 * Postgres (the `data` column is `text`) plus an optional type-guarded
 * `::numeric` cast so numeric comparisons don't fall back to lexical text
 * ordering.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any Kysely instance
export function jsonExtract(
	db: Kysely<any>,
	field: string,
	options?: { numeric?: boolean },
): string {
	return pluginDataExtractExpr(db, field, options);
}

/**
 * SQL expression for ordering by a `_plugin_storage.data` field.
 *
 * Delegates to `pluginDataOrderExpr`, which orders over the jsonb-native value
 * on Postgres so numeric fields sort numerically (not lexically) while staying
 * total across heterogeneous data. SQLite keeps `json_extract` (already numeric).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any Kysely instance
export function jsonOrderExtract(db: Kysely<any>, field: string): string {
	return pluginDataOrderExpr(db, field);
}

/**
 * Build a WHERE clause condition for a single field
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any Kysely instance
export function buildCondition(
	db: Kysely<any>,
	field: string,
	value: WhereValue,
): { sql: string; params: unknown[] } {
	// Numeric-vs-text is decided per condition from the JS type of the bound
	// value. On Postgres a text extract compared to a bound number would sort
	// lexically (`'9' >= '10'` is TRUE); a type-guarded `::numeric` cast on the
	// extract fixes it. String/boolean operands keep text comparison. SQLite is
	// unaffected — `json_extract` already returns a typed value.
	const extractFor = (numeric: boolean): string => jsonExtract(db, field, { numeric });

	if (value === null) {
		return { sql: `${extractFor(false)} IS NULL`, params: [] };
	}

	if (typeof value === "number") {
		return { sql: `${extractFor(true)} = ?`, params: [value] };
	}

	if (typeof value === "string") {
		return { sql: `${extractFor(false)} = ?`, params: [value] };
	}

	if (typeof value === "boolean") {
		// JSON booleans are stored as true/false strings
		return { sql: `${extractFor(false)} = ?`, params: [value] };
	}

	if (isInFilter(value)) {
		const numeric = value.in.length > 0 && value.in.every((v) => typeof v === "number");
		const placeholders = value.in.map(() => "?").join(", ");
		return {
			sql: `${extractFor(numeric)} IN (${placeholders})`,
			params: value.in,
		};
	}

	if (isStartsWithFilter(value)) {
		// ESCAPE '\' works on both SQLite and PostgreSQL. startsWith is a string
		// operation, so always compare as text.
		return {
			sql: `${extractFor(false)} LIKE ? ESCAPE '\\'`,
			params: [`${escapeLikePattern(value.startsWith)}%`],
		};
	}

	if (isRangeFilter(value)) {
		const conditions: string[] = [];
		const params: unknown[] = [];

		// Each bound is cast to numeric only when its own operand is a number, so
		// a mixed range (e.g. a string lower bound) stays correct per side.
		const pushBound = (op: string, bound: string | number): void => {
			conditions.push(`${extractFor(typeof bound === "number")} ${op} ?`);
			params.push(bound);
		};

		if (value.gt !== undefined) pushBound(">", value.gt);
		if (value.gte !== undefined) pushBound(">=", value.gte);
		if (value.lt !== undefined) pushBound("<", value.lt);
		if (value.lte !== undefined) pushBound("<=", value.lte);

		return {
			sql: conditions.join(" AND "),
			params,
		};
	}

	throw new StorageQueryError(`Unknown filter type for field '${field}'`);
}

/**
 * Build a complete WHERE clause from a WhereClause object
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any Kysely instance
export function buildWhereClause(
	db: Kysely<any>,
	where: WhereClause,
): {
	sql: string;
	params: unknown[];
} {
	const conditions: string[] = [];
	const params: unknown[] = [];

	for (const [field, value] of Object.entries(where)) {
		const condition = buildCondition(db, field, value);
		conditions.push(condition.sql);
		params.push(...condition.params);
	}

	if (conditions.length === 0) {
		return { sql: "", params: [] };
	}

	return {
		sql: conditions.join(" AND "),
		params,
	};
}

/**
 * Build ORDER BY clause
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any Kysely instance
export function buildOrderByClause(
	db: Kysely<any>,
	orderBy: Record<string, "asc" | "desc">,
): string {
	const clauses: string[] = [];

	for (const [field, direction] of Object.entries(orderBy)) {
		clauses.push(`${jsonOrderExtract(db, field)} ${direction.toUpperCase()}`);
	}

	if (clauses.length === 0) {
		return "";
	}

	return `ORDER BY ${clauses.join(", ")}`;
}

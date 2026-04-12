/**
 * Plugin Storage Query Validation and Building
 *
 * Validates that queries only use indexed fields and builds SQL WHERE clauses.
 *
 * @see PLUGIN-SYSTEM.md § Plugin Storage > Query Validation
 */

import type { Kysely } from "kysely";

import { jsonExtractExpr } from "../database/dialect-helpers.js";
import type { Database } from "../database/types.js";
import { validateJsonFieldName } from "../database/validate.js";
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
 * SQL expression for extracting JSON field.
 *
 * Validates the field name before interpolation to prevent SQL injection
 * via crafted JSON path expressions.
 */
export function jsonExtract(db: Kysely<Database>, field: string): string {
	validateJsonFieldName(field, "query field name");
	return jsonExtractExpr(db, "data", field);
}

/**
 * Build a WHERE clause condition for a single field
 */
export function buildCondition(
	db: Kysely<Database>,
	field: string,
	value: WhereValue,
): { sql: string; params: unknown[] } {
	const extract = jsonExtract(db, field);

	if (value === null) {
		return { sql: `${extract} IS NULL`, params: [] };
	}

	if (typeof value === "string" || typeof value === "number") {
		return { sql: `${extract} = ?`, params: [value] };
	}

	if (typeof value === "boolean") {
		// JSON booleans are stored as true/false strings
		return { sql: `${extract} = ?`, params: [value] };
	}

	if (isInFilter(value)) {
		const placeholders = value.in.map(() => "?").join(", ");
		return {
			sql: `${extract} IN (${placeholders})`,
			params: value.in,
		};
	}

	if (isStartsWithFilter(value)) {
		return {
			sql: `${extract} LIKE ?`,
			params: [`${value.startsWith}%`],
		};
	}

	if (isRangeFilter(value)) {
		const conditions: string[] = [];
		const params: unknown[] = [];

		if (value.gt !== undefined) {
			conditions.push(`${extract} > ?`);
			params.push(value.gt);
		}
		if (value.gte !== undefined) {
			conditions.push(`${extract} >= ?`);
			params.push(value.gte);
		}
		if (value.lt !== undefined) {
			conditions.push(`${extract} < ?`);
			params.push(value.lt);
		}
		if (value.lte !== undefined) {
			conditions.push(`${extract} <= ?`);
			params.push(value.lte);
		}

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
export function buildWhereClause(
	db: Kysely<Database>,
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
export function buildOrderByClause(
	db: Kysely<Database>,
	orderBy: Record<string, "asc" | "desc">,
): string {
	const clauses: string[] = [];

	for (const [field, direction] of Object.entries(orderBy)) {
		clauses.push(`${jsonExtract(db, field)} ${direction.toUpperCase()}`);
	}

	if (clauses.length === 0) {
		return "";
	}

	return `ORDER BY ${clauses.join(", ")}`;
}

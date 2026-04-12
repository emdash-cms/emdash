/**
 * Plugin Storage Index Management
 *
 * Manages expression indexes on the _plugin_storage table for efficient queries.
 *
 * @see PLUGIN-SYSTEM.md § Plugin Storage > Index Management
 */

import type { Kysely, RawBuilder } from "kysely";
import { sql } from "kysely";

import { jsonExtractExpr, isPostgres } from "../database/dialect-helpers.js";
import type { Database } from "../database/types.js";
import {
	validateIdentifier,
	validateJsonFieldName,
	validatePluginIdentifier,
} from "../database/validate.js";

/**
 * Generate a deterministic index name.
 * Unique indexes use a `uidx_` prefix to avoid collisions with regular indexes on the same fields.
 */
export function generateIndexName(
	pluginId: string,
	collection: string,
	fields: string[],
	options?: { unique?: boolean },
): string {
	const prefix = options?.unique ? "uidx" : "idx";
	const fieldPart = fields.join("_");
	// SQLite index names have no length limit, but keep it reasonable
	return `${prefix}_plugin_${pluginId}_${collection}_${fieldPart}`.substring(0, 128);
}

/**
 * Generate a Kysely sql expression for creating an expression index.
 *
 * Validates all identifiers before interpolation to prevent SQL injection.
 * Plugin ID and collection values are parameterized in the WHERE clause.
 */
export function generateCreateIndexSql(
	db: Kysely<Database>,
	pluginId: string,
	collection: string,
	fields: string[],
	options?: { unique?: boolean },
): RawBuilder<unknown> {
	// Validate all identifiers
	validatePluginIdentifier(pluginId, "plugin ID");
	validateIdentifier(collection, "collection name");
	for (const field of fields) {
		validateJsonFieldName(field, "index field name");
	}

	const indexName = generateIndexName(pluginId, collection, fields, options);

	// Build the indexed expressions
	// Fields are validated above, safe to interpolate into json path
	const expressions = fields
		.map((field) => {
			if (isPostgres(db)) {
				// Postgres expression indexes need parens around the expression
				return `(${jsonExtractExpr(db, "data", field)})`;
			}
			return jsonExtractExpr(db, "data", field);
		})
		.join(", ");

	// Partial index filtered to this plugin/collection
	// SQLite prohibits bound parameters in partial index WHERE clauses,
	// so we use sql.lit() for literal string values. Both pluginId and
	// collection are validated above, so this is safe.
	const createKeyword = options?.unique ? "CREATE UNIQUE INDEX" : "CREATE INDEX";
	return sql`${sql.raw(createKeyword)} IF NOT EXISTS ${sql.ref(indexName)}
		ON _plugin_storage(${sql.raw(expressions)})
		WHERE plugin_id = ${sql.lit(pluginId)} AND collection = ${sql.lit(collection)}
	`;
}

/**
 * Generate a Kysely sql expression for dropping an index.
 *
 * Uses sql.ref() for safe identifier quoting.
 */
export function generateDropIndexSql(indexName: string): RawBuilder<unknown> {
	return sql`DROP INDEX IF EXISTS ${sql.ref(indexName)}`;
}

/**
 * Normalize index declarations to arrays of field arrays
 */
export function normalizeIndexes(indexes: Array<string | string[]>): string[][] {
	return indexes.map((index) => (Array.isArray(index) ? index : [index]));
}

/**
 * Create all declared indexes for a plugin collection
 */
export async function createStorageIndexes(
	db: Kysely<Database>,
	pluginId: string,
	collection: string,
	indexes: Array<string | string[]>,
	options?: { uniqueIndexes?: Array<string | string[]> },
): Promise<{
	created: string[];
	errors: Array<{ index: string; error: string }>;
}> {
	const normalized = normalizeIndexes(indexes);
	const uniqueNormalized = options?.uniqueIndexes ? normalizeIndexes(options.uniqueIndexes) : [];
	const uniqueSet = new Set(uniqueNormalized.map((f) => f.join(",")));

	// Deduplicate: if fields appear in both indexes and uniqueIndexes, only create the unique version
	const deduped = normalized.filter((f) => !uniqueSet.has(f.join(",")));
	const allEntries: Array<{ fields: string[]; unique: boolean }> = [
		...deduped.map((fields) => ({ fields, unique: false })),
		...uniqueNormalized.map((fields) => ({ fields, unique: true })),
	];

	const created: string[] = [];
	const errors: Array<{ index: string; error: string }> = [];

	for (const entry of allEntries) {
		const { fields } = entry;
		const indexName = generateIndexName(pluginId, collection, fields, { unique: entry.unique });

		try {
			// Create the index
			const createSql = generateCreateIndexSql(db, pluginId, collection, fields, {
				unique: entry.unique,
			});
			await createSql.execute(db);

			// Track in _plugin_indexes table
			await db
				.insertInto("_plugin_indexes")
				.values({
					plugin_id: pluginId,
					collection,
					index_name: indexName,
					fields: JSON.stringify(fields),
				})
				.onConflict((oc) =>
					oc
						.columns(["plugin_id", "collection", "index_name"])
						.doUpdateSet({ fields: JSON.stringify(fields) }),
				)
				.execute();

			created.push(indexName);
		} catch (error) {
			errors.push({
				index: indexName,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return { created, errors };
}

/**
 * Remove indexes that are no longer declared
 */
export async function removeOrphanedIndexes(
	db: Kysely<Database>,
	pluginId: string,
	collection: string,
	currentIndexes: Array<string | string[]>,
	options?: { uniqueIndexes?: Array<string | string[]> },
): Promise<{
	removed: string[];
	errors: Array<{ index: string; error: string }>;
}> {
	const normalized = normalizeIndexes(currentIndexes);
	const uniqueNormalized = options?.uniqueIndexes ? normalizeIndexes(options.uniqueIndexes) : [];
	const uniqueSet = new Set(uniqueNormalized.map((f) => f.join(",")));

	// Build the set of expected index names (regular + unique with correct prefix)
	const currentIndexNames = new Set<string>();
	for (const fields of normalized) {
		// If this field set is in both, only the unique version exists (deduplication in create)
		if (!uniqueSet.has(fields.join(","))) {
			currentIndexNames.add(generateIndexName(pluginId, collection, fields));
		}
	}
	for (const fields of uniqueNormalized) {
		currentIndexNames.add(generateIndexName(pluginId, collection, fields, { unique: true }));
	}

	// Get existing indexes from tracking table
	const existingIndexes = await db
		.selectFrom("_plugin_indexes")
		.select(["index_name"])
		.where("plugin_id", "=", pluginId)
		.where("collection", "=", collection)
		.execute();

	const removed: string[] = [];
	const errors: Array<{ index: string; error: string }> = [];

	for (const { index_name } of existingIndexes) {
		if (!currentIndexNames.has(index_name)) {
			try {
				// Drop the index
				await generateDropIndexSql(index_name).execute(db);

				// Remove from tracking table
				await db
					.deleteFrom("_plugin_indexes")
					.where("plugin_id", "=", pluginId)
					.where("collection", "=", collection)
					.where("index_name", "=", index_name)
					.execute();

				removed.push(index_name);
			} catch (error) {
				errors.push({
					index: index_name,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	return { removed, errors };
}

/**
 * Sync indexes for a plugin collection (create new, remove old)
 */
export async function syncStorageIndexes(
	db: Kysely<Database>,
	pluginId: string,
	collection: string,
	indexes: Array<string | string[]>,
	options?: { uniqueIndexes?: Array<string | string[]> },
): Promise<{
	created: string[];
	removed: string[];
	errors: Array<{ index: string; error: string }>;
}> {
	const [createResult, removeResult] = await Promise.all([
		createStorageIndexes(db, pluginId, collection, indexes, options),
		removeOrphanedIndexes(db, pluginId, collection, indexes, options),
	]);

	return {
		created: createResult.created,
		removed: removeResult.removed,
		errors: [...createResult.errors, ...removeResult.errors],
	};
}

/**
 * Remove all indexes for a plugin
 */
export async function removeAllPluginIndexes(
	db: Kysely<Database>,
	pluginId: string,
): Promise<{
	removed: string[];
	errors: Array<{ index: string; error: string }>;
}> {
	const existingIndexes = await db
		.selectFrom("_plugin_indexes")
		.select(["index_name", "collection"])
		.where("plugin_id", "=", pluginId)
		.execute();

	const removed: string[] = [];
	const errors: Array<{ index: string; error: string }> = [];

	for (const { index_name } of existingIndexes) {
		try {
			await generateDropIndexSql(index_name).execute(db);
			removed.push(index_name);
		} catch (error) {
			errors.push({
				index: index_name,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	// Clean up tracking table
	await db.deleteFrom("_plugin_indexes").where("plugin_id", "=", pluginId).execute();

	return { removed, errors };
}

/**
 * Get current index status for a plugin
 */
export async function getPluginIndexStatus(
	db: Kysely<Database>,
	pluginId: string,
): Promise<
	Array<{
		collection: string;
		indexName: string;
		fields: string[];
		createdAt: string;
	}>
> {
	const rows = await db
		.selectFrom("_plugin_indexes")
		.select(["collection", "index_name", "fields", "created_at"])
		.where("plugin_id", "=", pluginId)
		.execute();

	return rows.map((row) => {
		const parsed: unknown = JSON.parse(row.fields);
		const fields = Array.isArray(parsed)
			? parsed.filter((f): f is string => typeof f === "string")
			: [];
		return {
			collection: row.collection,
			indexName: row.index_name,
			fields,
			createdAt: row.created_at,
		};
	});
}

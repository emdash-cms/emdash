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
import { generateIndexName } from "../database/plugin-storage-index-name.js";
import type { Database } from "../database/types.js";
import {
	validateJsonFieldName,
	validatePluginIdentifier,
	validateStorageCollectionName,
} from "../database/validate.js";

export { generateIndexName };

/**
 * Generate a Kysely sql expression for creating an expression index.
 *
 * Validates all inputs before interpolation. The collection uses the
 * permissive manifest-key rules rather than SQL-identifier rules — it is
 * stored as opaque text in index names and partial-index predicates.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any Kysely instance
export function generateCreateIndexSql(
	db: Kysely<any>,
	pluginId: string,
	collection: string,
	fields: string[],
	options?: { unique?: boolean },
): RawBuilder<unknown> {
	validatePluginIdentifier(pluginId, "plugin ID");
	validateStorageCollectionName(collection, "collection name");
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

	// Partial unique indexes enforce only the declaring scope. Keep regular
	// indexes non-partial so bound-parameter lookups work without ANALYZE on D1.
	const createKeyword = options?.unique ? "CREATE UNIQUE INDEX" : "CREATE INDEX";
	const predicate = options?.unique
		? sql`WHERE plugin_id = ${sql.lit(pluginId)} AND collection = ${sql.lit(collection)}`
		: sql``;
	return sql`${sql.raw(createKeyword)} IF NOT EXISTS ${sql.ref(indexName)}
		ON _plugin_storage(plugin_id, collection, ${sql.raw(expressions)})
		${predicate}
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

export function getStorageIndexDefinitions(
	indexes: Array<string | string[]>,
	options?: { uniqueIndexes?: Array<string | string[]> },
): Array<{ fields: string[]; unique: boolean }> {
	const normalized = normalizeIndexes(indexes);
	const uniqueNormalized = normalizeIndexes(options?.uniqueIndexes ?? []);
	const lookupFields = [
		...new Map(
			[...normalized, ...uniqueNormalized].map((fields) => [fields.join(","), fields]),
		).values(),
	];

	return [
		...lookupFields.map((fields) => ({ fields, unique: false })),
		...uniqueNormalized.map((fields) => ({ fields, unique: true })),
	];
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
	const allEntries = getStorageIndexDefinitions(indexes, options);

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

			// Track in _plugin_indexes table. Only rewrite the row when the stored
			// fields differ from the declared ones so repeated identical syncs do
			// not perform needless writes (see issue #4228).
			const fieldsJson = JSON.stringify(fields);
			await db
				.insertInto("_plugin_indexes")
				.values({
					plugin_id: pluginId,
					collection,
					index_name: indexName,
					fields: fieldsJson,
				})
				.onConflict((oc) =>
					oc
						.columns(["plugin_id", "collection", "index_name"])
						.doUpdateSet({ fields: fieldsJson })
						.whereRef("_plugin_indexes.fields", "!=", "excluded.fields"),
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
	// Build the set of expected index names (regular + unique with correct prefix)
	const currentIndexNames = new Set(
		getStorageIndexDefinitions(currentIndexes, options).map((entry) =>
			generateIndexName(pluginId, collection, entry.fields, { unique: entry.unique }),
		),
	);

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
	// A truncated legacy name can equal a new short name on PostgreSQL.
	// Drop stale indexes first so IF NOT EXISTS cannot reuse the wrong index.
	const removeResult = await removeOrphanedIndexes(db, pluginId, collection, indexes, options);
	const createResult = await createStorageIndexes(db, pluginId, collection, indexes, options);

	return {
		created: createResult.created,
		removed: removeResult.removed,
		errors: [...createResult.errors, ...removeResult.errors],
	};
}

export interface StorageIndexSyncResult {
	/** True only when every declared index for every passed plugin was materialized. */
	ok: boolean;
	/** Per-index failures, with enough context to identify which plugin/collection failed. */
	errors: Array<{ pluginId: string; collection: string; index: string; error: string }>;
}

/**
 * Materialize the storage indexes a set of plugins declare in their
 * manifests. Failures are logged per collection and returned in the result so
 * callers can decide whether to treat the sync as complete.
 */
export async function syncDeclaredStorageIndexes(
	db: Kysely<Database>,
	plugins: Array<{
		id: string;
		storage?: Record<
			string,
			{ indexes: Array<string | string[]>; uniqueIndexes?: Array<string | string[]> }
		>;
	}>,
): Promise<StorageIndexSyncResult> {
	const errors: StorageIndexSyncResult["errors"] = [];

	for (const plugin of plugins) {
		for (const [collection, config] of Object.entries(plugin.storage ?? {})) {
			try {
				const result = await syncStorageIndexes(db, plugin.id, collection, config.indexes, {
					uniqueIndexes: config.uniqueIndexes,
				});
				for (const failure of result.errors) {
					console.error(
						`[plugins] Failed to sync storage index ${failure.index} for ${plugin.id}/${collection}: ${failure.error}`,
					);
					errors.push({
						pluginId: plugin.id,
						collection,
						index: failure.index,
						error: failure.error,
					});
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(
					`[plugins] Failed to sync storage indexes for ${plugin.id}/${collection}:`,
					error,
				);
				errors.push({
					pluginId: plugin.id,
					collection,
					index: "(sync)",
					error: message,
				});
			}
		}
	}

	return { ok: errors.length === 0, errors };
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

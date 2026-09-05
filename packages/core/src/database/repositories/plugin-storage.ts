/**
 * Plugin Storage Repository
 *
 * Provides a document store API for plugin data storage.
 * Uses a single _plugin_storage table with JSON documents and expression indexes.
 *
 * @see PLUGIN-SYSTEM.md § Plugin Storage > Full API Reference
 */

import type { Kysely, RawBuilder } from "kysely";
import { sql } from "kysely";

import {
	buildWhereClause,
	validateWhereClause,
	validateOrderByClause,
	getIndexedFields,
	jsonOrderExtract,
	StorageQueryError,
} from "../../plugins/storage-query.js";
import type {
	StorageCollection,
	QueryOptions,
	PaginatedResult,
	WhereClause,
} from "../../plugins/types.js";
import { withTransaction } from "../transaction.js";
import type { Database } from "../types.js";
import { encodeCursor, decodeCursor } from "./types.js";

/**
 * Interleave a `?`-placeholder SQL string with its params into a single
 * boolean raw expression. Used as a WHERE predicate directly — wrapping it
 * in `(...) = 1` breaks on Postgres, which has a strict boolean type (#920).
 */
function rawWhereExpr(sqlText: string, params: unknown[]): RawBuilder<boolean> {
	const parts: ReturnType<typeof sql>[] = [];
	let paramIndex = 0;
	const sqlParts = sqlText.split("?");
	for (let i = 0; i < sqlParts.length; i++) {
		if (i > 0) {
			parts.push(sql`${params[paramIndex++]}`);
		}
		if (sqlParts[i]) {
			parts.push(sql.raw(sqlParts[i]));
		}
	}
	return sql<boolean>`(${sql.join(parts, sql.raw(""))})`;
}

/**
 * Plugin Storage Repository
 *
 * Implements the StorageCollection interface for a specific plugin and collection.
 */
/**
 * Rank a sort expression so NULLs get a deterministic position.
 *
 * A missing key in a schemaless document extracts as NULL, which sorts
 * differently per dialect (SQLite first, Postgres last) and makes every
 * comparison against it UNKNOWN. Sorting on this rank ahead of the value puts
 * NULLs in the same place on both dialects and keeps the seek operands
 * non-NULL.
 */
function nullRank(expr: RawBuilder<unknown>): RawBuilder<number> {
	return sql`(case when ${expr} is null then 1 else 0 end)`;
}

export class PluginStorageRepository<T = unknown> implements StorageCollection<T> {
	private indexedFields: Set<string>;

	constructor(
		private db: Kysely<Database>,
		private pluginId: string,
		private collection: string,
		indexes: Array<string | string[]>,
	) {
		this.indexedFields = getIndexedFields(indexes);
	}

	/**
	 * Get a document by ID
	 */
	async get(id: string): Promise<T | null> {
		const row = await this.db
			.selectFrom("_plugin_storage")
			.select("data")
			.where("plugin_id", "=", this.pluginId)
			.where("collection", "=", this.collection)
			.where("id", "=", id)
			.executeTakeFirst();

		if (!row) return null;
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse returns any; generic callers provide T
		return JSON.parse(row.data) as T;
	}

	/**
	 * Store a document
	 */
	async put(id: string, data: T): Promise<void> {
		const now = new Date().toISOString();
		const jsonData = JSON.stringify(data);

		await this.db
			.insertInto("_plugin_storage")
			.values({
				plugin_id: this.pluginId,
				collection: this.collection,
				id,
				data: jsonData,
				created_at: now,
				updated_at: now,
			})
			.onConflict((oc) =>
				oc.columns(["plugin_id", "collection", "id"]).doUpdateSet({
					data: jsonData,
					updated_at: now,
				}),
			)
			.execute();
	}

	/**
	 * Delete a document
	 */
	async delete(id: string): Promise<boolean> {
		const result = await this.db
			.deleteFrom("_plugin_storage")
			.where("plugin_id", "=", this.pluginId)
			.where("collection", "=", this.collection)
			.where("id", "=", id)
			.executeTakeFirst();

		return (result.numDeletedRows ?? 0) > 0;
	}

	/**
	 * Check if a document exists
	 */
	async exists(id: string): Promise<boolean> {
		const row = await this.db
			.selectFrom("_plugin_storage")
			.select("id")
			.where("plugin_id", "=", this.pluginId)
			.where("collection", "=", this.collection)
			.where("id", "=", id)
			.executeTakeFirst();

		return !!row;
	}

	/**
	 * Get multiple documents by ID
	 */
	async getMany(ids: string[]): Promise<Map<string, T>> {
		if (ids.length === 0) return new Map();

		const rows = await this.db
			.selectFrom("_plugin_storage")
			.select(["id", "data"])
			.where("plugin_id", "=", this.pluginId)
			.where("collection", "=", this.collection)
			.where("id", "in", ids)
			.execute();

		const result = new Map<string, T>();
		for (const row of rows) {
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse returns any; generic callers provide T
			result.set(row.id, JSON.parse(row.data) as T);
		}
		return result;
	}

	/**
	 * Store multiple documents
	 */
	async putMany(items: Array<{ id: string; data: T }>): Promise<void> {
		if (items.length === 0) return;

		const now = new Date().toISOString();

		// SQLite doesn't support batch upserts well, so we do them one at a time
		// In a transaction for atomicity
		await withTransaction(this.db, async (trx) => {
			for (const item of items) {
				const jsonData = JSON.stringify(item.data);
				await trx
					.insertInto("_plugin_storage")
					.values({
						plugin_id: this.pluginId,
						collection: this.collection,
						id: item.id,
						data: jsonData,
						created_at: now,
						updated_at: now,
					})
					.onConflict((oc) =>
						oc.columns(["plugin_id", "collection", "id"]).doUpdateSet({
							data: jsonData,
							updated_at: now,
						}),
					)
					.execute();
			}
		});
	}

	/**
	 * Delete multiple documents
	 */
	async deleteMany(ids: string[]): Promise<number> {
		if (ids.length === 0) return 0;

		const result = await this.db
			.deleteFrom("_plugin_storage")
			.where("plugin_id", "=", this.pluginId)
			.where("collection", "=", this.collection)
			.where("id", "in", ids)
			.executeTakeFirst();

		return Number(result.numDeletedRows ?? 0);
	}

	/**
	 * Query documents with filters
	 */
	async query(options: QueryOptions = {}): Promise<PaginatedResult<{ id: string; data: T }>> {
		const { where = {}, orderBy = {}, cursor } = options;
		const limit = Math.min(options.limit ?? 50, 100);

		// Validate that all queried fields are indexed
		validateWhereClause(where, this.indexedFields, this.pluginId, this.collection);
		if (Object.keys(orderBy).length > 0) {
			validateOrderByClause(orderBy, this.indexedFields, this.pluginId, this.collection);
		}

		// Build base query
		let query = this.db
			.selectFrom("_plugin_storage")
			.select(["id", "data", "created_at"])
			.where("plugin_id", "=", this.pluginId)
			.where("collection", "=", this.collection);

		// Add JSON extraction WHERE conditions
		const whereResult = buildWhereClause(this.db, where);
		if (whereResult.sql) {
			query = query.where(rawWhereExpr(whereResult.sql, whereResult.params));
		}

		const orderEntries = Object.entries(orderBy);
		const orderDirections = new Set(orderEntries.map(([, direction]) => direction));
		const descending = orderEntries.length > 0 && orderEntries[0][1] === "desc";

		// A missing key in a schemaless document extracts as NULL, and NULL sorts
		// differently per dialect (SQLite first, Postgres last) and makes any
		// comparison against it UNKNOWN. Rank nulls explicitly so both the sort and
		// the seek agree on where they sit, on either dialect, and so no comparison
		// operand is ever NULL.
		const sortExpr = (field: string): RawBuilder<unknown> =>
			sql`${sql.raw(jsonOrderExtract(this.db, field))}`;

		// Handle cursor-based pagination — throws on invalid cursor.
		if (cursor) {
			const decoded = decodeCursor(cursor);
			if (orderEntries.length === 0) {
				query = query.where(({ eb }) =>
					eb(sql`(created_at, id)`, ">", sql`(${decoded.orderValue}, ${decoded.id})`),
				);
			} else {
				if (orderDirections.size > 1) {
					throw new StorageQueryError(
						"Cursor pagination requires every orderBy field to share one direction.",
						Object.keys(orderBy).join(", "),
						"Sort every field the same way, or page without a cursor.",
					);
				}
				const op = descending ? sql`<` : sql`>`;
				// The cursor row's sort values, recomputed with the same expression
				// rather than carried in the cursor, so nothing is bound as a literal
				// and neither dialect has to coerce a JSON value to compare it.
				const cursorExpr = (field: string): RawBuilder<unknown> =>
					sql`(select ${sql.raw(jsonOrderExtract(this.db, field))} from _plugin_storage where plugin_id = ${this.pluginId} and collection = ${this.collection} and id = ${decoded.id})`;

				const fields = orderEntries.map(([field]) => {
					const own = sortExpr(field);
					const theirs = cursorExpr(field);
					return {
						equal: sql`(${nullRank(own)} = ${nullRank(theirs)} and (${nullRank(own)} = 1 or ${own} = ${theirs}))`,
						after: sql`(${nullRank(own)} ${op} ${nullRank(theirs)} or (${nullRank(own)} = ${nullRank(theirs)} and ${nullRank(own)} = 0 and ${own} ${op} ${theirs}))`,
					};
				});

				// Lexicographic seek: ties on every earlier field, then strictly after
				// on this one; finally all fields tied and strictly after on id.
				const terms = fields.map(
					(_, k) =>
						sql`(${sql.join([...fields.slice(0, k).map((f) => f.equal), fields[k].after], sql` and `)})`,
				);
				terms.push(
					sql`(${sql.join([...fields.map((f) => f.equal), sql`id ${op} ${decoded.id}`], sql` and `)})`,
				);
				query = query.where(sql<boolean>`(${sql.join(terms, sql` or `)})`);
			}
		}

		// Build ORDER BY using sql template
		if (orderEntries.length > 0) {
			for (const [field, direction] of orderEntries) {
				const dir = direction === "desc" ? sql`desc` : sql`asc`;
				const expr = sortExpr(field);
				// Null rank first so NULL placement is identical on both dialects.
				query = query.orderBy(sql`${nullRank(expr)} ${dir}`);
				// Order over the jsonb-native value on Postgres so numeric fields sort
				// numerically, not lexically. See pluginDataOrderExpr.
				query = query.orderBy(sql`${expr} ${dir}`);
			}
			// Total order, so a page boundary can never fall inside a group of ties.
			query = query.orderBy("id", descending ? "desc" : "asc");
		} else {
			// Default ordering for consistent pagination
			query = query.orderBy("created_at", "asc").orderBy("id", "asc");
		}

		// Apply limit (fetch one extra to detect if there's more)
		query = query.limit(limit + 1);

		const rows = await query.execute();

		const hasMore = rows.length > limit;
		const items = rows.slice(0, limit).map((row) => ({
			id: row.id,
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse returns any; generic callers provide T
			data: JSON.parse(row.data) as T,
		}));

		// Generate cursor for next page if there are more results
		let nextCursor: string | undefined;
		if (hasMore) {
			const lastItem = rows[limit - 1];
			if (lastItem) {
				nextCursor = encodeCursor(lastItem.created_at, lastItem.id);
			}
		}

		return { items, cursor: nextCursor, hasMore };
	}

	/**
	 * Count documents matching a filter
	 */
	async count(where?: WhereClause): Promise<number> {
		if (where && Object.keys(where).length > 0) {
			validateWhereClause(where, this.indexedFields, this.pluginId, this.collection);
		}

		let query = this.db
			.selectFrom("_plugin_storage")
			.select(sql<number>`COUNT(*)`.as("count"))
			.where("plugin_id", "=", this.pluginId)
			.where("collection", "=", this.collection);

		// Add JSON extraction WHERE conditions
		if (where && Object.keys(where).length > 0) {
			const whereResult = buildWhereClause(this.db, where);
			if (whereResult.sql) {
				query = query.where(rawWhereExpr(whereResult.sql, whereResult.params));
			}
		}

		const result = await query.executeTakeFirst();
		// Number() because the pg driver returns COUNT(*) (bigint) as a string.
		return Number(result?.count ?? 0);
	}
}

/**
 * Create a scoped storage accessor for a plugin
 */
export function createPluginStorageAccessor(
	db: Kysely<Database>,
	pluginId: string,
	storageConfig: Record<
		string,
		{ indexes: Array<string | string[]>; uniqueIndexes?: Array<string | string[]> }
	>,
): Record<string, StorageCollection> {
	const accessor: Record<string, StorageCollection> = {};

	for (const [collectionName, config] of Object.entries(storageConfig)) {
		const allIndexes = [...config.indexes, ...(config.uniqueIndexes ?? [])];
		accessor[collectionName] = new PluginStorageRepository(
			db,
			pluginId,
			collectionName,
			allIndexes,
		);
	}

	return accessor;
}

/**
 * Delete all storage data for a plugin
 */
export async function deleteAllPluginStorage(
	db: Kysely<Database>,
	pluginId: string,
): Promise<number> {
	const result = await db
		.deleteFrom("_plugin_storage")
		.where("plugin_id", "=", pluginId)
		.executeTakeFirst();

	return Number(result.numDeletedRows ?? 0);
}

/**
 * Delete all storage data for a plugin collection
 */
export async function deletePluginCollection(
	db: Kysely<Database>,
	pluginId: string,
	collection: string,
): Promise<number> {
	const result = await db
		.deleteFrom("_plugin_storage")
		.where("plugin_id", "=", pluginId)
		.where("collection", "=", collection)
		.executeTakeFirst();

	return Number(result.numDeletedRows ?? 0);
}

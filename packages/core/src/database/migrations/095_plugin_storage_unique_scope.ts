import type { Kysely } from "kysely";
import { sql } from "kysely";

import { isPostgres, jsonExtractExpr } from "../dialect-helpers.js";
import { generateIndexName, storageIndexHash } from "../plugin-storage-index-name.js";
import {
	validateJsonFieldName,
	validatePluginIdentifier,
	validateStorageCollectionName,
} from "../validate.js";

interface TrackedIndex {
	plugin_id: string;
	collection: string;
	index_name: string;
	fields: string;
}

async function* trackedUniqueIndexes(db: Kysely<unknown>): AsyncGenerator<TrackedIndex> {
	let cursor: TrackedIndex | undefined;
	while (true) {
		const after = cursor
			? sql`AND (plugin_id, collection, index_name) > (${cursor.plugin_id}, ${cursor.collection}, ${cursor.index_name})`
			: sql``;
		const { rows } = await sql<TrackedIndex>`
			SELECT plugin_id, collection, index_name, fields FROM _plugin_indexes
			WHERE index_name LIKE 'uidx_plugin_%' ${after}
			ORDER BY plugin_id, collection, index_name LIMIT 100
		`.execute(db);
		for (const row of rows) {
			if (row.index_name.startsWith("uidx_plugin_")) yield row;
		}
		if (rows.length < 100) return;
		cursor = rows.at(-1);
	}
}

function definition(db: Kysely<unknown>, row: TrackedIndex) {
	validatePluginIdentifier(row.plugin_id);
	validateStorageCollectionName(row.collection);
	const fields: unknown = JSON.parse(row.fields);
	if (!Array.isArray(fields) || fields.length === 0) {
		throw new Error(`Invalid fields for plugin storage index ${row.index_name}`);
	}
	for (const field of fields) validateJsonFieldName(field);
	const expressions = fields
		.map((field: string) => {
			const expr = jsonExtractExpr(db, "data", field);
			return isPostgres(db) ? `(${expr})` : expr;
		})
		.join(", ");
	return {
		expressions: sql.raw(expressions),
		predicate: sql`WHERE plugin_id = ${sql.lit(row.plugin_id)} AND collection = ${sql.lit(row.collection)}`,
		fieldNames: fields.join(", "),
		name: generateIndexName(row.plugin_id, row.collection, fields, { unique: true }),
		lookupName: generateIndexName(row.plugin_id, row.collection, fields),
		temporaryName: `uidx_m095_${storageIndexHash(row.plugin_id, row.collection, fields)}`,
	};
}

export async function up(db: Kysely<unknown>): Promise<void> {
	// PostgreSQL may have truncated several tracked names to one physical index.
	// Protect every scope before dropping any legacy index. D1 has no DDL transaction.
	for await (const row of trackedUniqueIndexes(db)) {
		const index = definition(db, row);
		try {
			await sql`CREATE UNIQUE INDEX IF NOT EXISTS ${sql.ref(index.temporaryName)}
				ON _plugin_storage(plugin_id, collection, ${index.expressions}) ${index.predicate}`.execute(
				db,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Failed to scope plugin storage unique index for ${row.plugin_id}/${row.collection} (${index.fieldNames}): ${message}`,
				{ cause: error },
			);
		}
	}
	// Drop all old names before creating replacements: a truncated legacy name
	// can also equal another scope's short, untruncated replacement name.
	for await (const row of trackedUniqueIndexes(db)) {
		await sql`DROP INDEX IF EXISTS ${sql.ref(row.index_name)}`.execute(db);
	}
	for await (const row of trackedUniqueIndexes(db)) {
		const index = definition(db, row);
		await sql`CREATE UNIQUE INDEX IF NOT EXISTS ${sql.ref(index.name)}
			ON _plugin_storage(plugin_id, collection, ${index.expressions}) ${index.predicate}`.execute(
			db,
		);
		await sql`INSERT INTO _plugin_indexes (plugin_id, collection, index_name, fields)
			VALUES (${row.plugin_id}, ${row.collection}, ${index.name}, ${row.fields})
			ON CONFLICT (plugin_id, collection, index_name) DO NOTHING`.execute(db);
		if (index.name !== row.index_name) {
			await sql`DELETE FROM _plugin_indexes
				WHERE plugin_id = ${row.plugin_id} AND collection = ${row.collection}
				AND index_name = ${row.index_name}`.execute(db);
		}
		// A partial index may not serve parameterized SQLite/D1 lookups.
		await sql`CREATE INDEX IF NOT EXISTS ${sql.ref(index.lookupName)}
			ON _plugin_storage(plugin_id, collection, ${index.expressions})`.execute(db);
		await sql`INSERT INTO _plugin_indexes (plugin_id, collection, index_name, fields)
			VALUES (${row.plugin_id}, ${row.collection}, ${index.lookupName}, ${row.fields})
			ON CONFLICT (plugin_id, collection, index_name) DO NOTHING`.execute(db);
	}
	for await (const row of trackedUniqueIndexes(db)) {
		const index = definition(db, row);
		await sql`DROP INDEX IF EXISTS ${sql.ref(index.temporaryName)}`.execute(db);
	}
}

export async function down(_db: Kysely<unknown>): Promise<void> {
	// Restoring table-wide uniqueness could reject valid out-of-scope rows.
}

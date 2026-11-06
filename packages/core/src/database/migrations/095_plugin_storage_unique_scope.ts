import type { Kysely } from "kysely";
import { sql } from "kysely";

import { isPostgres, jsonExtractExpr } from "../dialect-helpers.js";
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

export async function up(db: Kysely<unknown>): Promise<void> {
	const batchSize = 100;
	for (let offset = 0; ; offset += batchSize) {
		const { rows } = await sql<TrackedIndex>`
			SELECT plugin_id, collection, index_name, fields FROM _plugin_indexes
			WHERE index_name LIKE 'uidx_plugin_%'
			ORDER BY plugin_id, collection, index_name
			LIMIT ${batchSize} OFFSET ${offset}
		`.execute(db);
		for (const row of rows) {
			if (!row.index_name.startsWith("uidx_plugin_")) continue;
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
			const predicate = sql`WHERE plugin_id = ${sql.lit(row.plugin_id)} AND collection = ${sql.lit(row.collection)}`;
			const digest = await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(JSON.stringify([row.plugin_id, row.collection, row.index_name])),
			);
			const hash = Array.from(new Uint8Array(digest), (byte) =>
				byte.toString(16).padStart(2, "0"),
			).join("");
			const temporaryName = `uidx_m095_${hash.slice(0, 32)}`;
			// D1 cannot wrap DDL in a transaction. Keep scoped enforcement in place
			// across every statement, including a retry after a lost response.
			await sql`CREATE UNIQUE INDEX IF NOT EXISTS ${sql.ref(temporaryName)}
				ON _plugin_storage(plugin_id, collection, ${sql.raw(expressions)}) ${predicate}`.execute(
				db,
			);
			await sql`DROP INDEX IF EXISTS ${sql.ref(row.index_name)}`.execute(db);
			await sql`CREATE UNIQUE INDEX IF NOT EXISTS ${sql.ref(row.index_name)}
				ON _plugin_storage(plugin_id, collection, ${sql.raw(expressions)}) ${predicate}`.execute(
				db,
			);
			await sql`DROP INDEX IF EXISTS ${sql.ref(temporaryName)}`.execute(db);

			// A partial index may not serve parameterized SQLite/D1 lookups.
			const lookupName =
				`idx_plugin_${row.plugin_id}_${row.collection}_${fields.join("_")}`.substring(0, 128);
			await sql`CREATE INDEX IF NOT EXISTS ${sql.ref(lookupName)}
				ON _plugin_storage(plugin_id, collection, ${sql.raw(expressions)})`.execute(db);
			await sql`INSERT INTO _plugin_indexes (plugin_id, collection, index_name, fields)
				VALUES (${row.plugin_id}, ${row.collection}, ${lookupName}, ${row.fields})
				ON CONFLICT (plugin_id, collection, index_name) DO NOTHING`.execute(db);
		}
		if (rows.length < batchSize) break;
	}
}

export async function down(_db: Kysely<unknown>): Promise<void> {
	// Restoring table-wide uniqueness could reject valid out-of-scope rows.
}

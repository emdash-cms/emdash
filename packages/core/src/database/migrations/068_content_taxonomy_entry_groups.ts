import type { Kysely } from "kysely";
import { sql } from "kysely";

import { listTablesLike } from "../dialect-helpers.js";
import { validateIdentifier } from "../validate.js";

const LEGACY_DENORM_INDEXES = [
	"idx_content_taxonomies_pub",
	"idx_content_taxonomies_crt",
	"idx_content_taxonomies_loc_pub",
	"idx_content_taxonomies_loc_crt",
] as const;

/**
 * Store the content translation_group in content_taxonomies.entry_id.
 * Existing per-locale rows are merged into one assignment per content group
 * and term group. Rows whose content table or content entry no longer exists
 * are left untouched.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	const tableNames = await listTablesLike(db, "ec_%");
	for (const tableName of tableNames) {
		validateIdentifier(tableName, "content table name");
		const collection = tableName.slice("ec_".length);

		await sql`
			INSERT INTO content_taxonomies (collection, entry_id, taxonomy_id)
			SELECT DISTINCT ${collection}, content.translation_group, pivot.taxonomy_id
			FROM content_taxonomies AS pivot
			INNER JOIN ${sql.ref(tableName)} AS content ON content.id = pivot.entry_id
			WHERE pivot.collection = ${collection}
				AND content.translation_group IS NOT NULL
			ON CONFLICT (collection, entry_id, taxonomy_id) DO NOTHING
		`.execute(db);

		await sql`
			DELETE FROM content_taxonomies
			WHERE collection = ${collection}
				AND entry_id IN (
					SELECT id
					FROM ${sql.ref(tableName)}
					WHERE translation_group IS NOT NULL AND id != translation_group
				)
		`.execute(db);
	}

	for (const indexName of LEGACY_DENORM_INDEXES) {
		await sql`DROP INDEX IF EXISTS ${sql.ref(indexName)}`.execute(db);
	}
	await db.schema
		.createIndex("idx_content_taxonomies_group_lookup")
		.ifNotExists()
		.on("content_taxonomies")
		.columns(["taxonomy_id", "collection", "entry_id"])
		.execute();
}

/** The collapsed per-locale rows cannot be reconstructed. */
export async function down(_db: Kysely<unknown>): Promise<void> {
	// no-op
}

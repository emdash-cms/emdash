import type { Kysely } from "kysely";
import { sql } from "kysely";

import { isSqlite, tableExists } from "../dialect-helpers.js";

/**
 * Restore `_emdash_content_bylines` where migration 040's SQLite rebuild
 * stopped between dropping the old table and renaming the staged copy.
 *
 * 040 guards its rebuild on `PRAGMA foreign_key_list`, which returns no rows
 * for a missing table, so a retry after that partial run skips the rename and
 * leaves `_emdash_content_bylines_new` behind with the credits inside. The
 * indexes went with the dropped table.
 *
 * The Postgres path of 040 alters the table in place, so this is a no-op there.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	if (!isSqlite(db)) return;

	if (!(await tableExists(db, "_emdash_content_bylines"))) {
		if (!(await tableExists(db, "_emdash_content_bylines_new"))) return;
		await sql`ALTER TABLE _emdash_content_bylines_new RENAME TO _emdash_content_bylines`.execute(
			db,
		);
	}

	await db.schema
		.createIndex("idx_content_bylines_content")
		.ifNotExists()
		.on("_emdash_content_bylines")
		.columns(["collection_slug", "content_id", "sort_order"])
		.execute();
	await db.schema
		.createIndex("idx_content_bylines_byline")
		.ifNotExists()
		.on("_emdash_content_bylines")
		.column("byline_id")
		.execute();
}

export async function down(_db: Kysely<unknown>): Promise<void> {
	// no-op
}

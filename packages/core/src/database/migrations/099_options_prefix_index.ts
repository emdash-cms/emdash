import { type Kysely, sql } from "kysely";

import { isSqlite } from "../dialect-helpers.js";

export async function up(db: Kysely<unknown>): Promise<void> {
	if (!isSqlite(db)) return;

	// SQLite's default LIKE is ASCII case-insensitive, so the BINARY primary key cannot serve it.
	await db.schema
		.createIndex("idx_options_name_nocase")
		.ifNotExists()
		.on("options")
		.expression(sql`name COLLATE NOCASE`)
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	if (!isSqlite(db)) return;
	await db.schema.dropIndex("idx_options_name_nocase").ifExists().execute();
}

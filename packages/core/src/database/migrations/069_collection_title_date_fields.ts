import type { Kysely } from "kysely";
import { sql } from "kysely";

import { columnExists } from "../dialect-helpers.js";

/**
 * Migration: configurable title and date fields for collections
 *
 * Adds `title_field` and `date_field` columns to `_emdash_collections` so a
 * collection can override which field powers the Title column and which field
 * powers the Date column in the admin content list. Both are nullable — NULL
 * preserves the current defaults (title-style display, last-updated date).
 *
 * Column adds/drops are guarded by `columnExists`: D1 has no transactions, so a
 * migration can partially apply without being recorded and later re-run.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	if (!(await columnExists(db, "_emdash_collections", "title_field"))) {
		await sql`
			ALTER TABLE _emdash_collections
			ADD COLUMN title_field TEXT
		`.execute(db);
	}
	if (!(await columnExists(db, "_emdash_collections", "date_field"))) {
		await sql`
			ALTER TABLE _emdash_collections
			ADD COLUMN date_field TEXT
		`.execute(db);
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	if (await columnExists(db, "_emdash_collections", "date_field")) {
		await sql`
			ALTER TABLE _emdash_collections
			DROP COLUMN date_field
		`.execute(db);
	}
	if (await columnExists(db, "_emdash_collections", "title_field")) {
		await sql`
			ALTER TABLE _emdash_collections
			DROP COLUMN title_field
		`.execute(db);
	}
}

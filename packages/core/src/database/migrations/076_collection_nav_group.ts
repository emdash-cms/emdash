import type { Kysely } from "kysely";

import { columnExists } from "../dialect-helpers.js";

/**
 * Migration: group collections into admin sidebar folders.
 *
 * Adds `nav_group` to `_emdash_collections`. Collections sharing a group
 * render under one collapsible folder in the admin sidebar; NULL keeps the
 * collection inline.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	if (!(await columnExists(db, "_emdash_collections", "nav_group"))) {
		await db.schema.alterTable("_emdash_collections").addColumn("nav_group", "text").execute();
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	if (await columnExists(db, "_emdash_collections", "nav_group")) {
		await db.schema.alterTable("_emdash_collections").dropColumn("nav_group").execute();
	}
}

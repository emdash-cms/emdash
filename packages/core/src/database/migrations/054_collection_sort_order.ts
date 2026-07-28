import type { Kysely } from "kysely";

import { columnExists } from "../dialect-helpers.js";

/**
 * Migration: explicit collection order in the admin sidebar.
 *
 * Adds `sort_order` to `_emdash_collections`. The column is nullable on
 * purpose: NULL means "no explicit position", and those collections keep
 * falling back to the alphabetical-by-slug order the sidebar has always
 * used. Reads sort explicitly-ordered collections first (see
 * `COLLECTION_ORDER_SQL` in the schema registry), so existing sites are
 * untouched until someone reorders.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	if (!(await columnExists(db, "_emdash_collections", "sort_order"))) {
		await db.schema.alterTable("_emdash_collections").addColumn("sort_order", "integer").execute();
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("_emdash_collections").dropColumn("sort_order").execute();
}

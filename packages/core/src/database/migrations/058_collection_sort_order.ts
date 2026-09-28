import type { Kysely } from "kysely";

import { columnExists } from "../dialect-helpers.js";

/**
 * Migration: explicit collection order in the admin sidebar.
 *
 * Adds `sort_order` to `_emdash_collections`. A NULL `sort_order` means no
 * explicit position: those collections sort after the ordered ones, keeping
 * the alphabetical-by-slug order.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	if (!(await columnExists(db, "_emdash_collections", "sort_order"))) {
		await db.schema.alterTable("_emdash_collections").addColumn("sort_order", "integer").execute();
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("_emdash_collections").dropColumn("sort_order").execute();
}

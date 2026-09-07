import type { Kysely } from "kysely";

import { columnExists } from "../dialect-helpers.js";

/** Persist collection-level admin presentation options. */
export async function up(db: Kysely<unknown>): Promise<void> {
	if (!(await columnExists(db, "_emdash_collections", "admin_config"))) {
		await db.schema.alterTable("_emdash_collections").addColumn("admin_config", "text").execute();
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	if (await columnExists(db, "_emdash_collections", "admin_config")) {
		await db.schema.alterTable("_emdash_collections").dropColumn("admin_config").execute();
	}
}

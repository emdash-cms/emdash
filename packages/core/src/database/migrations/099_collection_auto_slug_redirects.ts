import type { Kysely } from "kysely";

import { columnExists } from "../dialect-helpers.js";

export async function up(db: Kysely<unknown>): Promise<void> {
	if (!(await columnExists(db, "_emdash_collections", "auto_slug_redirects"))) {
		await db.schema
			.alterTable("_emdash_collections")
			.addColumn("auto_slug_redirects", "integer", (col) => col.notNull().defaultTo(1))
			.execute();
	}
}

export async function down(_db: Kysely<unknown>): Promise<void> {
	// Migrations are forward-only.
}

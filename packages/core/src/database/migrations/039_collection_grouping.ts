import { type Kysely } from "kysely";

import { columnExists } from "../dialect-helpers.js";

export async function up(db: Kysely<unknown>): Promise<void> {
	if (!(await columnExists(db, "_emdash_collections", "sort_order"))) {
		await db.schema
			.alterTable("_emdash_collections")
			.addColumn("sort_order", "integer", (col) => col.defaultTo(0))
			.execute();
	}

	if (!(await columnExists(db, "_emdash_collections", "group"))) {
		await db.schema
			.alterTable("_emdash_collections")
			.addColumn("group", "text")
			.execute();
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	if (await columnExists(db, "_emdash_collections", "sort_order")) {
		await db.schema.alterTable("_emdash_collections").dropColumn("sort_order").execute();
	}

	if (await columnExists(db, "_emdash_collections", "group")) {
		await db.schema.alterTable("_emdash_collections").dropColumn("group").execute();
	}
}

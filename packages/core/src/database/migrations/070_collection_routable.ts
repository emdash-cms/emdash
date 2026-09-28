import type { Kysely } from "kysely";

import { columnExists } from "../dialect-helpers.js";

export async function up(db: Kysely<unknown>): Promise<void> {
	if (!(await columnExists(db, "_emdash_collections", "routable"))) {
		await db.schema
			.alterTable("_emdash_collections")
			.addColumn("routable", "integer", (col) => col.notNull().defaultTo(1))
			.execute();
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	if (await columnExists(db, "_emdash_collections", "routable")) {
		await db.schema.alterTable("_emdash_collections").dropColumn("routable").execute();
	}
}

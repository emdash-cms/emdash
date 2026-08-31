import type { Kysely } from "kysely";

import { columnExists } from "../dialect-helpers.js";

export async function up(db: Kysely<unknown>): Promise<void> {
	if (!(await columnExists(db, "media", "visibility"))) {
		await db.schema
			.alterTable("media")
			.addColumn("visibility", "text", (col) => col.notNull().defaultTo("public"))
			.execute();
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	if (await columnExists(db, "media", "visibility")) {
		await db.schema.alterTable("media").dropColumn("visibility").execute();
	}
}

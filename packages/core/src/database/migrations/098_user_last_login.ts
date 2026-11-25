import type { Kysely } from "kysely";

import { columnExists } from "../dialect-helpers.js";

export async function up(db: Kysely<unknown>): Promise<void> {
	if (!(await columnExists(db, "users", "last_login_at"))) {
		await db.schema.alterTable("users").addColumn("last_login_at", "text").execute();
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.alterTable("users").dropColumn("last_login_at").execute();
}

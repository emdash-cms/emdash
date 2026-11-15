import type { Kysely } from "kysely";

import { columnExists } from "../dialect-helpers.js";

export async function up(db: Kysely<unknown>): Promise<void> {
	for (const column of ["first_name", "last_name"]) {
		if (await columnExists(db, "_emdash_shop_customers", column)) continue;
		await db.schema.alterTable("_emdash_shop_customers").addColumn(column, "text").execute();
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	for (const column of ["last_name", "first_name"]) {
		if (!(await columnExists(db, "_emdash_shop_customers", column))) continue;
		await db.schema.alterTable("_emdash_shop_customers").dropColumn(column).execute();
	}
}

import type { Kysely } from "kysely";

import { columnExists } from "../dialect-helpers.js";

export async function up(db: Kysely<unknown>): Promise<void> {
	if (!(await columnExists(db, "_emdash_shop_orders", "tracking_token_hash"))) {
		await db.schema
			.alterTable("_emdash_shop_orders")
			.addColumn("tracking_token_hash", "text")
			.execute();
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	if (await columnExists(db, "_emdash_shop_orders", "tracking_token_hash")) {
		await db.schema.alterTable("_emdash_shop_orders").dropColumn("tracking_token_hash").execute();
	}
}

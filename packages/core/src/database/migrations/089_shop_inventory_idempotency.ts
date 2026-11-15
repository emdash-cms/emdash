import type { Kysely } from "kysely";

import { columnExists } from "../dialect-helpers.js";

export async function up(db: Kysely<unknown>): Promise<void> {
	if (await columnExists(db, "_emdash_shop_inventory_movements", "event_key")) return;
	await db.schema
		.alterTable("_emdash_shop_inventory_movements")
		.addColumn("event_key", "text")
		.execute();
	await db.schema
		.createIndex("idx_shop_inventory_movements_event_key")
		.ifNotExists()
		.on("_emdash_shop_inventory_movements")
		.column("event_key")
		.unique()
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropIndex("idx_shop_inventory_movements_event_key").ifExists().execute();
	if (await columnExists(db, "_emdash_shop_inventory_movements", "event_key")) {
		await db.schema.alterTable("_emdash_shop_inventory_movements").dropColumn("event_key").execute();
	}
}

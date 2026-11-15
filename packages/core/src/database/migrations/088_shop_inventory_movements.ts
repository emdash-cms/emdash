import type { Kysely } from "kysely";

import { currentTimestamp } from "../dialect-helpers.js";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("_emdash_shop_inventory_movements")
		.ifNotExists()
		.addColumn("id", "text", (column) => column.primaryKey())
		.addColumn("product_id", "text", (column) => column.notNull())
		.addColumn("variant_id", "text")
		.addColumn("order_id", "text")
		.addColumn("order_item_id", "text")
		.addColumn("type", "text", (column) => column.notNull())
		.addColumn("quantity_delta", "integer", (column) => column.notNull())
		.addColumn("reason", "text")
		.addColumn("reference_type", "text")
		.addColumn("reference_id", "text")
		.addColumn("created_at", "text", (column) => column.defaultTo(currentTimestamp(db)))
		.execute();

	await db.schema
		.createIndex("idx_shop_inventory_movements_product")
		.ifNotExists()
		.on("_emdash_shop_inventory_movements")
		.columns(["product_id", "variant_id", "created_at"])
		.execute();
	await db.schema
		.createIndex("idx_shop_inventory_movements_order")
		.ifNotExists()
		.on("_emdash_shop_inventory_movements")
		.columns(["order_id", "order_item_id"])
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("_emdash_shop_inventory_movements").ifExists().execute();
}

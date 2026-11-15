import type { Kysely } from "kysely";

import { currentTimestamp } from "../dialect-helpers.js";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("_emdash_shop_carts")
		.ifNotExists()
		.addColumn("id", "text", (column) => column.primaryKey())
		.addColumn("user_id", "text")
		.addColumn("guest_token_hash", "text")
		.addColumn("status", "text", (column) => column.notNull().defaultTo("active"))
		.addColumn("currency", "text", (column) => column.notNull())
		.addColumn("locale", "text", (column) => column.notNull().defaultTo("en"))
		.addColumn("expires_at", "text", (column) => column.notNull())
		.addColumn("converted_order_id", "text")
		.addColumn("created_at", "text", (column) => column.defaultTo(currentTimestamp(db)))
		.addColumn("updated_at", "text", (column) => column.defaultTo(currentTimestamp(db)))
		.addColumn("last_accessed_at", "text", (column) => column.defaultTo(currentTimestamp(db)))
		.execute();

	await db.schema
		.createTable("_emdash_shop_cart_items")
		.ifNotExists()
		.addColumn("id", "text", (column) => column.primaryKey())
		.addColumn("cart_id", "text", (column) => column.notNull())
		.addColumn("collection", "text", (column) => column.notNull().defaultTo("products"))
		.addColumn("product_id", "text", (column) => column.notNull())
		.addColumn("variant_id", "text")
		.addColumn("quantity", "integer", (column) => column.notNull())
		.addColumn("created_at", "text", (column) => column.defaultTo(currentTimestamp(db)))
		.addColumn("updated_at", "text", (column) => column.defaultTo(currentTimestamp(db)))
		.execute();

	await db.schema
		.createIndex("idx_shop_carts_guest_token")
		.ifNotExists()
		.on("_emdash_shop_carts")
		.column("guest_token_hash")
		.execute();
	await db.schema
		.createIndex("idx_shop_carts_user_status")
		.ifNotExists()
		.on("_emdash_shop_carts")
		.columns(["user_id", "status"])
		.execute();
	await db.schema
		.createIndex("idx_shop_carts_expiry")
		.ifNotExists()
		.on("_emdash_shop_carts")
		.columns(["status", "expires_at"])
		.execute();
	await db.schema
		.createIndex("idx_shop_cart_items_cart")
		.ifNotExists()
		.on("_emdash_shop_cart_items")
		.columns(["cart_id", "created_at"])
		.execute();
	await db.schema
		.createIndex("idx_shop_cart_items_product")
		.ifNotExists()
		.on("_emdash_shop_cart_items")
		.columns(["product_id", "variant_id"])
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("_emdash_shop_cart_items").ifExists().execute();
	await db.schema.dropTable("_emdash_shop_carts").ifExists().execute();
}

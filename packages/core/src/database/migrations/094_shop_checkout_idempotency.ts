import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("_emdash_shop_checkout_requests")
		.ifNotExists()
		.addColumn("idempotency_key_hash", "text", (column) => column.primaryKey())
		.addColumn("request_hash", "text", (column) => column.notNull())
		.addColumn("order_id", "text", (column) => column.notNull().unique())
		.addColumn("created_at", "text", (column) => column.notNull())
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("_emdash_shop_checkout_requests").ifExists().execute();
}

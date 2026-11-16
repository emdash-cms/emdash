import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("_emdash_shop_email_outbox")
		.ifNotExists()
		.addColumn("order_id", "text", (column) => column.primaryKey())
		.addColumn("status", "text", (column) => column.notNull().defaultTo("pending"))
		.addColumn("attempted_at", "text")
		.addColumn("sent_at", "text")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("_emdash_shop_email_outbox").ifExists().execute();
}

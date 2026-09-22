import type { Kysely } from "kysely";

import { currentTimestamp } from "../dialect-helpers.js";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("_emdash_media_upload_attempts")
		.ifNotExists()
		.addColumn("storage_key", "text", (col) => col.primaryKey())
		.addColumn("media_id", "text", (col) => col.notNull())
		.addColumn("status", "text", (col) => col.notNull().defaultTo("active"))
		.addColumn("created_at", "text", (col) => col.notNull().defaultTo(currentTimestamp(db)))
		.addColumn("updated_at", "text", (col) => col.notNull().defaultTo(currentTimestamp(db)))
		.execute();

	await db.schema
		.createIndex("idx_media_upload_attempts_media_id")
		.ifNotExists()
		.on("_emdash_media_upload_attempts")
		.column("media_id")
		.execute();

	await db.schema
		.createIndex("idx_media_upload_attempts_status_created_at")
		.ifNotExists()
		.on("_emdash_media_upload_attempts")
		.columns(["status", "created_at"])
		.execute();

	await db.schema
		.createIndex("idx_media_storage_key")
		.ifNotExists()
		.on("media")
		.column("storage_key")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropIndex("idx_media_storage_key").ifExists().execute();
	await db.schema.dropTable("_emdash_media_upload_attempts").ifExists().execute();
}

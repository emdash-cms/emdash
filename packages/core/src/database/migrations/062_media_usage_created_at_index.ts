import type { Kysely } from "kysely";

// Cleanup queries filter and order `_emdash_media_usage` rows by `created_at`,
// but the existing identity-leading indexes cannot satisfy those scans directly.

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createIndex("idx__emdash_media_usage_created_at")
		.ifNotExists()
		.on("_emdash_media_usage")
		.column("created_at")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropIndex("idx__emdash_media_usage_created_at").ifExists().execute();
}

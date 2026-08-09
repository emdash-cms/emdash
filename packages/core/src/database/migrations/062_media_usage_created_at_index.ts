import type { Kysely } from "kysely";

// Cleanup queries filter `_emdash_media_usage` rows by `created_at` and batch
// in `(created_at, id)` order; the existing identity-leading indexes cannot
// satisfy those scans, and the trailing `id` column lets the batch ordering
// come straight off the index with no residual sort.

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createIndex("idx__emdash_media_usage_created_at")
		.ifNotExists()
		.on("_emdash_media_usage")
		.columns(["created_at", "id"])
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropIndex("idx__emdash_media_usage_created_at").ifExists().execute();
}

import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createIndex("idx__emdash_media_usage_status_cleanup_due")
		.ifNotExists()
		.on("_emdash_media_usage_index_status")
		.columns([
			"adapter_id",
			"scope_type",
			"capture_state",
			"cleanup_state",
			"cleanup_next_attempt_at",
			"updated_at",
			"collection_id",
		])
		.execute();
	await db.schema
		.createIndex("idx__emdash_media_usage_status_cleanup_lease")
		.ifNotExists()
		.on("_emdash_media_usage_index_status")
		.columns([
			"adapter_id",
			"scope_type",
			"capture_state",
			"cleanup_state",
			"cleanup_lease_expires_at",
			"updated_at",
			"collection_id",
		])
		.execute();
	await db.schema
		.createIndex("idx__emdash_media_usage_sources_cleanup")
		.ifNotExists()
		.on("_emdash_media_usage_sources")
		.columns(["source_type", "collection_id", "source_key"])
		.execute();
	await db.schema
		.createIndex("idx__emdash_media_usage_occurrences_cleanup")
		.ifNotExists()
		.on("_emdash_media_usage")
		.columns(["source_key", "id"])
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropIndex("idx__emdash_media_usage_occurrences_cleanup").ifExists().execute();
	await db.schema.dropIndex("idx__emdash_media_usage_sources_cleanup").ifExists().execute();
	await db.schema.dropIndex("idx__emdash_media_usage_status_cleanup_lease").ifExists().execute();
	await db.schema.dropIndex("idx__emdash_media_usage_status_cleanup_due").ifExists().execute();
}

import type { Kysely } from "kysely";

import { currentTimestamp } from "../dialect-helpers.js";

/**
 * Internal media usage projection tables.
 *
 * This migration is DDL-only by design: no backfill, no runtime media/indexing
 * imports, and no content-table scans. Production rows are introduced by later
 * phases once the central snapshot/indexer path is reviewed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("_emdash_media_usage_sources")
		.ifNotExists()
		.addColumn("source_key", "text", (c) => c.primaryKey())
		.addColumn("source_type", "text", (c) => c.notNull())
		.addColumn("collection_slug", "text")
		.addColumn("content_id", "text")
		.addColumn("source_variant", "text", (c) => c.notNull())
		.addColumn("locale", "text")
		.addColumn("translation_group", "text")
		.addColumn("content_slug", "text")
		.addColumn("content_title", "text")
		.addColumn("content_status", "text")
		.addColumn("content_scheduled_at", "text")
		.addColumn("content_deleted_at", "text")
		.addColumn("revision_id", "text")
		.addColumn("current_generation", "text", (c) => c.notNull())
		.addColumn("schema_version", "integer", (c) => c.notNull().defaultTo(1))
		.addColumn("indexed_at", "text", (c) => c.notNull().defaultTo(currentTimestamp(db)))
		.addColumn("created_at", "text", (c) => c.defaultTo(currentTimestamp(db)))
		.addColumn("updated_at", "text", (c) => c.defaultTo(currentTimestamp(db)))
		.execute();

	await db.schema
		.createIndex("idx__emdash_media_usage_sources_content")
		.ifNotExists()
		.on("_emdash_media_usage_sources")
		.columns(["source_type", "collection_slug", "content_id"])
		.execute();
	await db.schema
		.createIndex("idx__emdash_media_usage_sources_variant")
		.ifNotExists()
		.on("_emdash_media_usage_sources")
		.columns(["source_type", "source_variant"])
		.execute();
	await db.schema
		.createIndex("idx__emdash_media_usage_sources_locale")
		.ifNotExists()
		.on("_emdash_media_usage_sources")
		.columns(["collection_slug", "locale"])
		.execute();
	await db.schema
		.createIndex("idx__emdash_media_usage_sources_deleted")
		.ifNotExists()
		.on("_emdash_media_usage_sources")
		.column("content_deleted_at")
		.execute();
	await db.schema
		.createIndex("idx__emdash_media_usage_sources_translation_group")
		.ifNotExists()
		.on("_emdash_media_usage_sources")
		.columns(["collection_slug", "translation_group"])
		.execute();

	await db.schema
		.createTable("_emdash_media_usage")
		.ifNotExists()
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("source_key", "text", (c) => c.notNull())
		.addColumn("generation", "text", (c) => c.notNull())
		.addColumn("field_slug", "text", (c) => c.notNull())
		.addColumn("field_path", "text", (c) => c.notNull())
		.addColumn("occurrence_index", "integer", (c) => c.notNull().defaultTo(0))
		.addColumn("reference_type", "text", (c) => c.notNull())
		.addColumn("media_id", "text")
		.addColumn("provider", "text", (c) => c.notNull().defaultTo("local"))
		.addColumn("provider_asset_id", "text", (c) => c.notNull())
		.addColumn("media_kind", "text")
		.addColumn("mime_type", "text")
		.addColumn("created_at", "text", (c) => c.defaultTo(currentTimestamp(db)))
		.execute();

	await db.schema
		.createIndex("idx__emdash_media_usage_unique_occurrence")
		.ifNotExists()
		.unique()
		.on("_emdash_media_usage")
		.columns(["source_key", "generation", "field_path", "occurrence_index"])
		.execute();
	await db.schema
		.createIndex("idx__emdash_media_usage_media_id")
		.ifNotExists()
		.on("_emdash_media_usage")
		.column("media_id")
		.execute();
	await db.schema
		.createIndex("idx__emdash_media_usage_provider_asset")
		.ifNotExists()
		.on("_emdash_media_usage")
		.columns(["provider", "provider_asset_id"])
		.execute();
	await db.schema
		.createIndex("idx__emdash_media_usage_source_generation")
		.ifNotExists()
		.on("_emdash_media_usage")
		.columns(["source_key", "generation"])
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("_emdash_media_usage").ifExists().execute();
	await db.schema.dropTable("_emdash_media_usage_sources").ifExists().execute();
}

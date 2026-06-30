import { sql, type Kysely } from "kysely";

import { currentTimestamp } from "../dialect-helpers.js";
import type { Database } from "../types.js";

/**
 * Media usage index.
 *
 * Sources describe the indexed thing (`content:posts:01...:live`), while usage
 * rows describe individual media occurrences within the source. Usage rows are
 * generation-tagged so D1 can insert a new generation before flipping the source
 * pointer, avoiding a visible empty index if replacement work fails midway.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("_emdash_media_usage_sources")
		.ifNotExists()
		.addColumn("source_key", "text", (c) => c.primaryKey())
		.addColumn("source_type", "text", (c) => c.notNull())
		.addColumn("collection", "text")
		.addColumn("content_id", "text")
		.addColumn("content_slug", "text")
		.addColumn("locale", "text")
		.addColumn("translation_group", "text")
		.addColumn("content_status", "text")
		.addColumn("content_deleted_at", "text")
		.addColumn("state", "text", (c) => c.notNull())
		.addColumn("revision_id", "text")
		.addColumn("current_generation", "text", (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.defaultTo(currentTimestamp(db)))
		.addColumn("updated_at", "text", (c) => c.defaultTo(currentTimestamp(db)))
		.execute();

	await db.schema
		.createIndex("idx__emdash_media_usage_sources_content")
		.ifNotExists()
		.on("_emdash_media_usage_sources")
		.columns(["collection", "content_id", "state"])
		.execute();
	await db.schema
		.createIndex("idx__emdash_media_usage_sources_translation_group")
		.ifNotExists()
		.on("_emdash_media_usage_sources")
		.columns(["collection", "translation_group", "state"])
		.execute();
	await db.schema
		.createIndex("idx__emdash_media_usage_sources_state")
		.ifNotExists()
		.on("_emdash_media_usage_sources")
		.column("state")
		.execute();

	await db.schema
		.createTable("_emdash_media_usage")
		.ifNotExists()
		.addColumn("id", "text", (c) => c.primaryKey())
		.addColumn("source_key", "text", (c) => c.notNull())
		.addColumn("generation", "text", (c) => c.notNull())
		.addColumn("media_id", "text")
		.addColumn("provider", "text", (c) => c.notNull().defaultTo("local"))
		.addColumn("provider_asset_id", "text", (c) => c.notNull())
		.addColumn("media_kind", "text")
		.addColumn("mime_type", "text")
		.addColumn("reference_type", "text", (c) => c.notNull())
		.addColumn("field_path", "text", (c) => c.notNull())
		.addColumn("sort_order", "integer", (c) => c.notNull().defaultTo(0))
		.addColumn("created_at", "text", (c) => c.defaultTo(currentTimestamp(db)))
		.addUniqueConstraint("media_usage_occurrence_unique", [
			"source_key",
			"generation",
			"field_path",
		])
		.execute();

	await db.schema
		.createIndex("idx__emdash_media_usage_media")
		.ifNotExists()
		.on("_emdash_media_usage")
		.columns(["media_id", "source_key"])
		.execute();
	await db.schema
		.createIndex("idx__emdash_media_usage_provider_asset")
		.ifNotExists()
		.on("_emdash_media_usage")
		.columns(["provider", "provider_asset_id", "source_key"])
		.execute();
	await db.schema
		.createIndex("idx__emdash_media_usage_source_generation")
		.ifNotExists()
		.on("_emdash_media_usage")
		.columns(["source_key", "generation"])
		.execute();

	await backfillExistingContentMediaUsage(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropTable("_emdash_media_usage").ifExists().execute();
	await db.schema.dropTable("_emdash_media_usage_sources").ifExists().execute();
}

async function backfillExistingContentMediaUsage(db: Kysely<unknown>): Promise<void> {
	const collections = await sql<{ slug: string }>`
		SELECT slug FROM _emdash_collections
	`.execute(db);
	const { replaceCollectionMediaUsage } = await import("../../media/usage-index.js");

	for (const collection of collections.rows) {
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- migration runs against Kysely<unknown>, runtime helper needs the generated DB type
		await replaceCollectionMediaUsage(db as Kysely<Database>, collection.slug);
	}
}

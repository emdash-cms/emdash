import type { Kysely } from "kysely";

const OLD_INDEX = "idx__emdash_media_usage_media_id";
const READ_INDEX = "idx__emdash_media_usage_media_source_generation";

export async function up(db: Kysely<unknown>): Promise<void> {
	// D1 DDL is non-transactional: create the replacement before dropping the
	// old index so an interrupted migration always leaves a media-leading index.
	await db.schema
		.createIndex(READ_INDEX)
		.ifNotExists()
		.on("_emdash_media_usage")
		.columns(["media_id", "source_key", "generation"])
		.execute();
	await db.schema.dropIndex(OLD_INDEX).ifExists().execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createIndex(OLD_INDEX)
		.ifNotExists()
		.on("_emdash_media_usage")
		.column("media_id")
		.execute();
	await db.schema.dropIndex(READ_INDEX).ifExists().execute();
}

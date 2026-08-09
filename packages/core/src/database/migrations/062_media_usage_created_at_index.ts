import type { Kysely } from "kysely";

// The maintenance sweep (cleanupMediaUsageGenerations) selects and deletes
// media-usage rows by age, ordered on created_at. The table's other indexes
// (046, 052) all lead with identity columns, so age-gated scans read the
// whole table once a backlog builds up.

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

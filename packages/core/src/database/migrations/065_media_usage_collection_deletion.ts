import { sql, type Kysely, type RawBuilder } from "kysely";

import { isPostgres } from "../dialect-helpers.js";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("_emdash_media_usage_collection_deletions")
		.ifNotExists()
		.addColumn("collection_id", "text", (column) => column.notNull().primaryKey())
		.addColumn("collection_slug", "text", (column) => column.notNull().unique())
		.addColumn("force_delete", "integer", (column) => column.notNull())
		.addColumn("state", "text", (column) => column.notNull().defaultTo("pending"))
		.addColumn("phase", "text", (column) => column.notNull().defaultTo("fence"))
		.addColumn("work_cursor", "text")
		.addColumn("source_key", "text")
		.addColumn("occurrence_cursor", "text")
		.addColumn("attempt_count", "integer", (column) => column.notNull().defaultTo(0))
		.addColumn("next_attempt_at", "text", (column) => column.notNull())
		.addColumn("lease_token", "text")
		.addColumn("lease_expires_at", "text")
		.addColumn("last_error_code", "text")
		.addColumn("created_at", "text", (column) =>
			column.notNull().defaultTo(sortableUtcTimestamp(db)),
		)
		.addColumn("updated_at", "text", (column) =>
			column.notNull().defaultTo(sortableUtcTimestamp(db)),
		)
		.execute();

	await db.schema
		.createIndex("idx__emdash_media_usage_collection_deletions_due")
		.ifNotExists()
		.on("_emdash_media_usage_collection_deletions")
		.columns(["state", "next_attempt_at", "updated_at", "collection_id"])
		.execute();
	await db.schema
		.createIndex("idx__emdash_media_usage_collection_deletions_lease")
		.ifNotExists()
		.on("_emdash_media_usage_collection_deletions")
		.columns(["state", "lease_expires_at", "updated_at", "collection_id"])
		.execute();
	await db.schema
		.createIndex("idx__emdash_media_usage_collection_deletions_operator")
		.ifNotExists()
		.on("_emdash_media_usage_collection_deletions")
		.columns(["state", "updated_at", "collection_id"])
		.execute();
	await db.schema
		.createIndex("idx__emdash_media_usage_sources_collection_cursor")
		.ifNotExists()
		.on("_emdash_media_usage_sources")
		.columns(["source_type", "collection_id", "source_key"])
		.execute();
	await db.schema
		.createIndex("idx__emdash_media_usage_source_cursor")
		.ifNotExists()
		.on("_emdash_media_usage")
		.columns(["source_key", "id"])
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	const deletion = await sql<{ present: number }>`
		SELECT 1 AS present
		FROM _emdash_media_usage_collection_deletions
		LIMIT 1
	`.execute(db);
	if (deletion.rows.length > 0) {
		throw new Error("Cannot roll back while durable collection deletion evidence exists");
	}

	await db.schema.dropIndex("idx__emdash_media_usage_source_cursor").ifExists().execute();
	await db.schema
		.dropIndex("idx__emdash_media_usage_sources_collection_cursor")
		.ifExists()
		.execute();
	await db.schema.dropTable("_emdash_media_usage_collection_deletions").ifExists().execute();
}

function sortableUtcTimestamp(db: Kysely<unknown>): RawBuilder<string> {
	if (isPostgres(db)) {
		return sql`to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
	}
	return sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
}

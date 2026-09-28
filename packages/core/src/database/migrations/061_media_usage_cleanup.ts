import { sql, type Kysely } from "kysely";

import { currentTimestamp } from "../dialect-helpers.js";

const CLEANUP_TASK_KEY = "projection_gc";
const INITIAL_ELIGIBLE_AT = "1970-01-01T00:00:00.000Z";

export async function up(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createIndex("idx__emdash_media_usage_cleanup_scan")
		.ifNotExists()
		.on("_emdash_media_usage")
		.columns(["created_at", "id", "source_key", "generation"])
		.execute();

	await db.schema
		.createTable("_emdash_media_usage_cleanup")
		.ifNotExists()
		.addColumn("task_key", "text", (c) => c.primaryKey())
		.addColumn("lease_token", "text")
		.addColumn("lease_expires_at", "text")
		.addColumn("next_eligible_at", "text", (c) => c.notNull())
		.addColumn("cursor_created_at", "text")
		.addColumn("cursor_id", "text")
		.addColumn("scan_before_at", "text")
		.addColumn("consecutive_failures", "integer", (c) => c.notNull().defaultTo(0))
		.addColumn("last_started_at", "text")
		.addColumn("last_completed_at", "text")
		.addColumn("last_candidate_count", "integer", (c) => c.notNull().defaultTo(0))
		.addColumn("last_deleted_orphans", "integer", (c) => c.notNull().defaultTo(0))
		.addColumn("last_deleted_stale", "integer", (c) => c.notNull().defaultTo(0))
		.addColumn("last_deleted_abandoned", "integer", (c) => c.notNull().defaultTo(0))
		.addColumn("last_deleted_write_leases", "integer", (c) => c.notNull().defaultTo(0))
		.addColumn("last_backlog_lower_bound", "integer", (c) => c.notNull().defaultTo(0))
		.addColumn("last_scan_has_more", "integer", (c) => c.notNull().defaultTo(0))
		.addColumn("last_duration_ms", "integer", (c) => c.notNull().defaultTo(0))
		.addColumn("last_error_code", "text")
		.addColumn("updated_at", "text", (c) => c.notNull().defaultTo(currentTimestamp(db)))
		.execute();

	await db.schema
		.createTable("_emdash_media_usage_generation_writes")
		.ifNotExists()
		.addColumn("source_key", "text", (c) => c.notNull())
		.addColumn("generation", "text", (c) => c.notNull())
		.addColumn("lease_token", "text", (c) => c.primaryKey())
		.addColumn("expires_at", "text", (c) => c.notNull())
		.addColumn("created_at", "text", (c) => c.notNull().defaultTo(currentTimestamp(db)))
		.addUniqueConstraint("_emdash_media_usage_generation_writes_source_generation", [
			"source_key",
			"generation",
		])
		.execute();

	await db.schema
		.createIndex("idx__emdash_media_usage_generation_writes_expiry")
		.ifNotExists()
		.on("_emdash_media_usage_generation_writes")
		.columns(["expires_at", "lease_token"])
		.execute();

	await sql`
		INSERT INTO _emdash_media_usage_cleanup (task_key, next_eligible_at)
		VALUES (${CLEANUP_TASK_KEY}, ${INITIAL_ELIGIBLE_AT})
		ON CONFLICT (task_key) DO NOTHING
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.dropIndex("idx__emdash_media_usage_generation_writes_expiry")
		.ifExists()
		.execute();
	await db.schema.dropTable("_emdash_media_usage_generation_writes").ifExists().execute();
	await db.schema.dropTable("_emdash_media_usage_cleanup").ifExists().execute();
	await db.schema.dropIndex("idx__emdash_media_usage_cleanup_scan").ifExists().execute();
}

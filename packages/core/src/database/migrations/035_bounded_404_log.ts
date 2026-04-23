import type { Kysely } from "kysely";
import { sql } from "kysely";

/**
 * Migration: Bounded 404 logging
 *
 * Hardens `_emdash_404_log` against unauthenticated DoS. Previously every 404
 * inserted a new row, so an attacker could grow the table without bound.
 *
 * Changes:
 *   - Adds `hits` (default 1) and `last_seen_at` (default current timestamp)
 *   - Backfills existing rows: hits=1, last_seen_at=created_at
 *   - Deduplicates existing rows by path, keeping the most recent row per
 *     path and summing hits
 *   - Adds a UNIQUE index on `path` so upsert semantics work
 */

export async function up(db: Kysely<unknown>): Promise<void> {
	// 1. Add columns.
	await db.schema
		.alterTable("_emdash_404_log")
		.addColumn("hits", "integer", (col) => col.notNull().defaultTo(1))
		.execute();

	// SQLite won't accept a non-constant default when adding a NOT NULL column
	// to a table with existing rows, so backfill in two steps: add nullable,
	// populate, then rely on the application layer / future inserts to set it.
	await db.schema.alterTable("_emdash_404_log").addColumn("last_seen_at", "text").execute();

	// Backfill last_seen_at from created_at for existing rows.
	await sql`
		UPDATE _emdash_404_log
		SET last_seen_at = created_at
		WHERE last_seen_at IS NULL
	`.execute(db);

	// 2. Deduplicate existing rows by path.
	//    For each path, keep the row with the most recent created_at, set its
	//    hits to the count of rows for that path, set last_seen_at to the
	//    latest created_at, and delete the rest.
	await sql`
		UPDATE _emdash_404_log
		SET
			hits = (
				SELECT COUNT(*) FROM _emdash_404_log AS inner_log
				WHERE inner_log.path = _emdash_404_log.path
			),
			last_seen_at = (
				SELECT MAX(created_at) FROM _emdash_404_log AS inner_log
				WHERE inner_log.path = _emdash_404_log.path
			)
		WHERE id IN (
			SELECT id FROM _emdash_404_log AS outer_log
			WHERE created_at = (
				SELECT MAX(created_at) FROM _emdash_404_log AS inner_log
				WHERE inner_log.path = outer_log.path
			)
		)
	`.execute(db);

	// Delete the duplicates (rows that weren't the most recent per path).
	await sql`
		DELETE FROM _emdash_404_log
		WHERE id NOT IN (
			SELECT id FROM (
				SELECT id FROM _emdash_404_log AS outer_log
				WHERE created_at = (
					SELECT MAX(created_at) FROM _emdash_404_log AS inner_log
					WHERE inner_log.path = outer_log.path
				)
				GROUP BY path
			)
		)
	`.execute(db);

	// 3. Add unique index on path for upsert semantics.
	await db.schema
		.createIndex("idx_404_log_path_unique")
		.on("_emdash_404_log")
		.column("path")
		.unique()
		.execute();

	// Drop the old non-unique index; the unique one covers the same lookups.
	await db.schema.dropIndex("idx_404_log_path").execute();

	// 4. Index on last_seen_at for eviction ordering.
	await db.schema
		.createIndex("idx_404_log_last_seen")
		.on("_emdash_404_log")
		.column("last_seen_at")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropIndex("idx_404_log_last_seen").execute();
	await db.schema.dropIndex("idx_404_log_path_unique").execute();

	// Restore the original non-unique path index.
	await db.schema.createIndex("idx_404_log_path").on("_emdash_404_log").column("path").execute();

	await db.schema.alterTable("_emdash_404_log").dropColumn("last_seen_at").execute();
	await db.schema.alterTable("_emdash_404_log").dropColumn("hits").execute();
}

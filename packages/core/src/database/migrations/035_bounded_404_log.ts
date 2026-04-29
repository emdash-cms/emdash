import type { Kysely } from "kysely";
import { sql } from "kysely";

import { columnExists } from "../dialect-helpers.js";

/**
 * Migration: Bounded 404 logging
 *
 * Hardens `_emdash_404_log` against unauthenticated DoS. Previously every 404
 * inserted a new row, so an attacker could grow the table without bound.
 *
 * Changes:
 *   - Adds `hits` (default 1, NOT NULL)
 *   - Adds `last_seen_at` (nullable; SQLite can't add NOT NULL with a
 *     non-constant default to a populated table, so the column is nullable
 *     at the schema level and backfilled from `created_at` for existing rows;
 *     new inserts via `log404` always set it)
 *   - Deduplicates existing rows by path, keeping the most recent row per
 *     path and summing hits
 *   - Adds a UNIQUE index on `path` so upsert semantics work
 */

export async function up(db: Kysely<unknown>): Promise<void> {
	const hitsExists = await columnExists(db, "_emdash_404_log", "hits");

	// 1. Add columns.
	if (!hitsExists) {
		await db.schema
			.alterTable("_emdash_404_log")
			.addColumn("hits", "integer", (col) => col.notNull().defaultTo(1))
			.execute();
	}

	// SQLite won't accept a non-constant default when adding a NOT NULL column
	// to a table with existing rows, so backfill in two steps: add nullable,
	// populate, then rely on the application layer / future inserts to set it.
	if (!(await columnExists(db, "_emdash_404_log", "last_seen_at"))) {
		await db.schema.alterTable("_emdash_404_log").addColumn("last_seen_at", "text").execute();
	}

	// Backfill last_seen_at from created_at for existing rows.
	await sql`
		UPDATE _emdash_404_log
		SET last_seen_at = created_at
		WHERE last_seen_at IS NULL
	`.execute(db);

	// 2. Deduplicate existing rows by path.
	//    For each path, roll up hits and pick the freshest last_seen_at onto
	//    a single keeper row, then delete the non-keepers. Uses window
	//    functions (ROW_NUMBER) so the dedup SQL is valid on both SQLite
	//    (3.25+, 2018) and Postgres. The previous GROUP BY approach was
	//    accepted by SQLite but invalid on Postgres because `id` wasn't in
	//    the GROUP BY or wrapped in an aggregate.
	if (!hitsExists) {
		await sql`
			WITH ranked AS (
				SELECT
					id,
					path,
					ROW_NUMBER() OVER (
						PARTITION BY path
						ORDER BY created_at DESC, id DESC
					) AS rn,
					COUNT(*) OVER (PARTITION BY path) AS path_count,
					MAX(created_at) OVER (PARTITION BY path) AS latest_created_at
				FROM _emdash_404_log
			)
			UPDATE _emdash_404_log
			SET
				hits = (SELECT path_count FROM ranked WHERE ranked.id = _emdash_404_log.id),
				last_seen_at = (SELECT latest_created_at FROM ranked WHERE ranked.id = _emdash_404_log.id)
			WHERE id IN (SELECT id FROM ranked WHERE rn = 1)
		`.execute(db);

		// Delete the non-keepers (every row except the freshest per path).
		await sql`
			DELETE FROM _emdash_404_log
			WHERE id IN (
				SELECT id FROM (
					SELECT
						id,
						ROW_NUMBER() OVER (
							PARTITION BY path
							ORDER BY created_at DESC, id DESC
						) AS rn
					FROM _emdash_404_log
				) AS ranked
				WHERE rn > 1
			)
		`.execute(db);
	}

	// 3. Add unique index on path for upsert semantics.
	await db.schema
		.createIndex("idx_404_log_path_unique")
		.ifNotExists()
		.on("_emdash_404_log")
		.column("path")
		.unique()
		.execute();

	// Drop the old non-unique index; the unique one covers the same lookups.
	await db.schema.dropIndex("idx_404_log_path").ifExists().execute();

	// 4. Index on last_seen_at for eviction ordering.
	await db.schema
		.createIndex("idx_404_log_last_seen")
		.ifNotExists()
		.on("_emdash_404_log")
		.column("last_seen_at")
		.execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await db.schema.dropIndex("idx_404_log_last_seen").ifExists().execute();
	await db.schema.dropIndex("idx_404_log_path_unique").ifExists().execute();

	// Restore the original non-unique path index.
	await db.schema
		.createIndex("idx_404_log_path")
		.ifNotExists()
		.on("_emdash_404_log")
		.column("path")
		.execute();

	await db.schema.alterTable("_emdash_404_log").dropColumn("last_seen_at").execute();
	await db.schema.alterTable("_emdash_404_log").dropColumn("hits").execute();
}

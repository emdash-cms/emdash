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
	//    every row of that path, then delete the non-keepers. Uses a single
	//    GROUP BY aggregate joined by `path` so the per-path aggregates are
	//    computed once — O(n) — rather than once per row.
	//
	//    Earlier versions of this migration computed the aggregates as
	//    window functions inside a CTE and referenced that CTE three times
	//    from the outer UPDATE (twice as correlated subqueries in the SET
	//    list). Postgres inlines non-recursive CTEs and does not share
	//    materialization across references, so each row of the UPDATE
	//    re-evaluated the full window pipeline — O(n²). On a populated
	//    `_emdash_404_log` (~200k rows of bot/scanner noise is realistic)
	//    that wedged the migration for tens of minutes and OOM'd the pg
	//    client buffer. See #1085.
	//
	//    Because every row of a given path receives the same `hits` and
	//    `last_seen_at`, the keeper retained by the DELETE below is
	//    guaranteed to hold the correct rolled-up values. Updating
	//    soon-to-be-deleted rows is wasted work but keeps the SQL portable
	//    (avoids the dialect split between `UPDATE … FROM …` join keys),
	//    and the linear cost dominates the slightly-wider write set.
	if (!hitsExists) {
		// Surface row count up-front so operators can see the migration is
		// proportional to table size rather than guessing it has hung.
		const countRow = (
			await sql<{
				n: number | string;
			}>`SELECT COUNT(*) AS n FROM _emdash_404_log`.execute(db)
		).rows[0];
		const rowCount = countRow ? Number(countRow.n) : 0;
		if (rowCount > 0) {
			// eslint-disable-next-line no-console
			console.warn(
				`[migration 035] deduplicating _emdash_404_log (${rowCount} rows)` +
					(rowCount > 50_000
						? " — large tables may take a few minutes; consider TRUNCATE if the table only holds bot/scanner noise"
						: ""),
			);

			await sql`
				UPDATE _emdash_404_log
				SET
					hits = agg.path_count,
					last_seen_at = agg.latest_created_at
				FROM (
					SELECT
						path,
						COUNT(*) AS path_count,
						MAX(created_at) AS latest_created_at
					FROM _emdash_404_log
					GROUP BY path
				) AS agg
				WHERE _emdash_404_log.path = agg.path
			`.execute(db);

			// Delete the non-keepers (every row except the freshest per path).
			// References the window-function subquery exactly once, so it
			// materializes once and runs in a single linear pass.
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

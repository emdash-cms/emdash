import type { Kysely } from "kysely";
import { sql } from "kysely";

import { listTablesLike } from "../dialect-helpers.js";

/**
 * Migration: replace the single-column partial `scheduled_at` index on content
 * tables with a `(deleted_at, scheduled_at)` composite.
 *
 * The scheduled-publishing sweep filters `scheduled_at` by range and
 * `deleted_at IS NULL`, ordered by `scheduled_at`. A `scheduled_at`-only index
 * cannot satisfy the soft-delete term, so a stats-blind planner seeks a
 * `deleted_at`-leading composite instead and reads every live row. Leading with
 * `deleted_at` lets one index serve the equality, the range, and the ORDER BY.
 * D1 never has `sqlite_stat1`, so the index shape is the only lever.
 *
 * The partial predicate from migration 030 is kept so the index stays
 * proportional to scheduled content rather than to the table.
 *
 * Forward-only and idempotent (`IF NOT EXISTS`).
 *
 * The short `del_sched` suffix keeps the name inside Postgres's 63-byte
 * identifier limit for long collection slugs. Keep it identical to the name in
 * `schema/registry.ts`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	const tableNames = await listTablesLike(db, "ec_%");

	for (const tableName of tableNames) {
		// D1 DDL is non-transactional: create the replacement before dropping the
		// old index so an interrupted migration always leaves a scheduled_at index
		// in place.
		await sql`
			CREATE INDEX IF NOT EXISTS ${sql.ref(`idx_${tableName}_del_sched`)}
			ON ${sql.ref(tableName)} (deleted_at, scheduled_at)
			WHERE scheduled_at IS NOT NULL
		`.execute(db);

		await sql`DROP INDEX IF EXISTS ${sql.ref(`idx_${tableName}_scheduled`)}`.execute(db);
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	const tableNames = await listTablesLike(db, "ec_%");

	for (const tableName of tableNames) {
		await sql`
			CREATE INDEX IF NOT EXISTS ${sql.ref(`idx_${tableName}_scheduled`)}
			ON ${sql.ref(tableName)} (scheduled_at)
			WHERE scheduled_at IS NOT NULL
		`.execute(db);

		await sql`DROP INDEX IF EXISTS ${sql.ref(`idx_${tableName}_del_sched`)}`.execute(db);
	}
}

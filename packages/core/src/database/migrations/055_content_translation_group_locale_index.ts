import type { Kysely } from "kysely";
import { sql } from "kysely";

import { listTablesLike } from "../dialect-helpers.js";

/**
 * Migration: replace the single-column content `translation_group` index with
 * one index per translation-group read shape.
 *
 * There are two shapes. Translation-group reads filter `deleted_at IS NULL`
 * with `translation_group = ?` / `IN (...)` and order by locale; menu and
 * reference resolution looks a group up by `translation_group` (+ `locale`)
 * alone, with no `deleted_at` term.
 *
 * Neither shape can borrow the other's index. Seeking migration 041's
 * `(deleted_at, locale, ...)` composites on `deleted_at` alone already returns
 * rows in locale order, so a stats-blind planner prefers them over a
 * single-column `translation_group` index and reads every non-deleted row in
 * the table; the batched variant is worse still, because the `IN (...)` list
 * multiplies the planner's row estimate for a `translation_group`-leading index
 * and it falls back to a `deleted_at` composite from a handful of groups
 * onward. Going the other way, an index leading with `deleted_at` cannot seek a
 * lookup that never constrains that column. D1 never has `sqlite_stat1`, so the
 * index shape is the only lever and each shape needs a prefix matching it term
 * for term.
 *
 * Forward-only and idempotent (`IF NOT EXISTS`).
 *
 * Index names use short `tg_locale` / `del_tg_locale` suffixes rather than
 * spelling out `translation_group`: Postgres truncates identifiers to 63 bytes,
 * and the longer forms truncate to the same value for long collection slugs.
 * Keep these identical to the names in `schema/registry.ts`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	const tableNames = await listTablesLike(db, "ec_%");

	for (const tableName of tableNames) {
		// D1 DDL is non-transactional: create the replacements before dropping the
		// old index so an interrupted migration always leaves a
		// translation_group-leading index in place.
		await sql`
			CREATE INDEX IF NOT EXISTS ${sql.ref(`idx_${tableName}_tg_locale`)}
			ON ${sql.ref(tableName)} (translation_group, locale)
		`.execute(db);

		await sql`
			CREATE INDEX IF NOT EXISTS ${sql.ref(`idx_${tableName}_del_tg_locale`)}
			ON ${sql.ref(tableName)} (deleted_at, translation_group, locale)
		`.execute(db);

		await sql`DROP INDEX IF EXISTS ${sql.ref(`idx_${tableName}_translation_group`)}`.execute(db);
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	const tableNames = await listTablesLike(db, "ec_%");

	for (const tableName of tableNames) {
		await sql`
			CREATE INDEX IF NOT EXISTS ${sql.ref(`idx_${tableName}_translation_group`)}
			ON ${sql.ref(tableName)} (translation_group)
		`.execute(db);

		await sql`DROP INDEX IF EXISTS ${sql.ref(`idx_${tableName}_del_tg_locale`)}`.execute(db);
		await sql`DROP INDEX IF EXISTS ${sql.ref(`idx_${tableName}_tg_locale`)}`.execute(db);
	}
}

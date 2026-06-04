import type { Kysely } from "kysely";
import { sql } from "kysely";

import { listTablesLike } from "../dialect-helpers.js";

/**
 * Migration: locale-aware composite indexes for content list queries.
 *
 * Addresses GitHub issue #1219. When i18n is enabled the admin content list
 * filters by `locale` and orders by `updated_at`/`created_at`. The existing
 * composite indexes (033/034) cover `(deleted_at, updated_at DESC, id DESC)`
 * etc. but omit `locale`, so a locale-filtered ordered list can't be served
 * by a single index on large tables. These indexes restore index-only paging
 * for the locale-scoped case.
 *
 * Forward-only and idempotent (`IF NOT EXISTS`).
 *
 * Index names use a short `loc_upd`/`loc_crt` suffix rather than spelling out
 * `deleted_locale_updated_id`: Postgres truncates identifiers to 63 bytes, and
 * the longer form pushes the `updated`/`created` discriminator past byte 63 for
 * slugs as short as 40 chars, making both names truncate to the same string.
 * Keep these identical to the names in `schema/registry.ts`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	const tableNames = await listTablesLike(db, "ec_%");

	for (const tableName of tableNames) {
		await sql`
			CREATE INDEX IF NOT EXISTS ${sql.ref(`idx_${tableName}_loc_upd`)}
			ON ${sql.ref(tableName)} (deleted_at, locale, updated_at DESC, id DESC)
		`.execute(db);

		await sql`
			CREATE INDEX IF NOT EXISTS ${sql.ref(`idx_${tableName}_loc_crt`)}
			ON ${sql.ref(tableName)} (deleted_at, locale, created_at DESC, id DESC)
		`.execute(db);
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	const tableNames = await listTablesLike(db, "ec_%");

	for (const tableName of tableNames) {
		await sql`DROP INDEX IF EXISTS ${sql.ref(`idx_${tableName}_loc_upd`)}`.execute(db);
		await sql`DROP INDEX IF EXISTS ${sql.ref(`idx_${tableName}_loc_crt`)}`.execute(db);
	}
}

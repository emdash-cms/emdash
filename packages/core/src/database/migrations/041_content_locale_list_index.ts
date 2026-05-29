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
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	const tableNames = await listTablesLike(db, "ec_%");

	for (const tableName of tableNames) {
		await sql`
			CREATE INDEX IF NOT EXISTS ${sql.ref(`idx_${tableName}_deleted_locale_updated_id`)}
			ON ${sql.ref(tableName)} (deleted_at, locale, updated_at DESC, id DESC)
		`.execute(db);

		await sql`
			CREATE INDEX IF NOT EXISTS ${sql.ref(`idx_${tableName}_deleted_locale_created_id`)}
			ON ${sql.ref(tableName)} (deleted_at, locale, created_at DESC, id DESC)
		`.execute(db);
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	const tableNames = await listTablesLike(db, "ec_%");

	for (const tableName of tableNames) {
		await sql`DROP INDEX IF EXISTS ${sql.ref(`idx_${tableName}_deleted_locale_updated_id`)}`.execute(
			db,
		);
		await sql`DROP INDEX IF EXISTS ${sql.ref(`idx_${tableName}_deleted_locale_created_id`)}`.execute(
			db,
		);
	}
}

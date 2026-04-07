import type { Kysely } from "kysely";
import { sql } from "kysely";

import { listTablesLike } from "../dialect-helpers.js";

/**
 * Migration: Optimize content table indexes for D1 performance
 *
 * Addresses GitHub issue #131: Full table scans causing massive D1 row reads.
 *
 * Changes:
 * 1. Replaces single-column indexes with composite indexes on ec_* tables
 * 2. Adds partial indexes for _emdash_comments status counting
 *
 * Impact: Reduces D1 row reads by 90%+ for admin panel operations.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	const tableNames = await listTablesLike(db, "ec_%");

	for (const tableName of tableNames) {
		const table = { name: tableName };

		// Drop redundant single-column indexes that will be replaced by composites
		await sql`DROP INDEX IF EXISTS ${sql.ref(`idx_${table.name}_status`)}`.execute(db);
		await sql`DROP INDEX IF EXISTS ${sql.ref(`idx_${table.name}_created`)}`.execute(db);
		await sql`DROP INDEX IF EXISTS ${sql.ref(`idx_${table.name}_deleted`)}`.execute(db);
		await sql`DROP INDEX IF EXISTS ${sql.ref(`idx_${table.name}_updated`)}`.execute(db);

		// Composite index for listing queries: WHERE deleted_at IS NULL ORDER BY updated_at DESC
		await sql`
			CREATE INDEX ${sql.ref(`idx_${table.name}_deleted_updated_id`)}
			ON ${sql.ref(table.name)} (deleted_at, updated_at DESC, id DESC)
		`.execute(db);

		// Composite index for count-by-status queries: WHERE deleted_at IS NULL AND status = ?
		await sql`
			CREATE INDEX ${sql.ref(`idx_${table.name}_deleted_status`)}
			ON ${sql.ref(table.name)} (deleted_at, status)
		`.execute(db);

		// Composite index for created-at ordering: WHERE deleted_at IS NULL ORDER BY created_at DESC
		await sql`
			CREATE INDEX ${sql.ref(`idx_${table.name}_deleted_created_id`)}
			ON ${sql.ref(table.name)} (deleted_at, created_at DESC, id DESC)
		`.execute(db);
	}

	// Add partial indexes for efficient comment status counting
	// Each index contains only rows for one status, enabling fast COUNT queries
	await sql`
		CREATE INDEX idx_comments_pending
		ON _emdash_comments (id)
		WHERE status = 'pending'
	`.execute(db);

	await sql`
		CREATE INDEX idx_comments_approved
		ON _emdash_comments (id)
		WHERE status = 'approved'
	`.execute(db);

	await sql`
		CREATE INDEX idx_comments_spam
		ON _emdash_comments (id)
		WHERE status = 'spam'
	`.execute(db);

	await sql`
		CREATE INDEX idx_comments_trash
		ON _emdash_comments (id)
		WHERE status = 'trash'
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	const tableNames = await listTablesLike(db, "ec_%");

	for (const tableName of tableNames) {
		const table = { name: tableName };

		// Drop composite indexes
		await sql`DROP INDEX IF EXISTS ${sql.ref(`idx_${table.name}_deleted_updated_id`)}`.execute(db);
		await sql`DROP INDEX IF EXISTS ${sql.ref(`idx_${table.name}_deleted_status`)}`.execute(db);
		await sql`DROP INDEX IF EXISTS ${sql.ref(`idx_${table.name}_deleted_created_id`)}`.execute(db);

		// Restore original single-column indexes
		await sql`
			CREATE INDEX ${sql.ref(`idx_${table.name}_status`)}
			ON ${sql.ref(table.name)} (status)
		`.execute(db);

		await sql`
			CREATE INDEX ${sql.ref(`idx_${table.name}_created`)}
			ON ${sql.ref(table.name)} (created_at)
		`.execute(db);

		await sql`
			CREATE INDEX ${sql.ref(`idx_${table.name}_deleted`)}
			ON ${sql.ref(table.name)} (deleted_at)
		`.execute(db);

		await sql`
			CREATE INDEX ${sql.ref(`idx_${table.name}_updated`)}
			ON ${sql.ref(table.name)} (updated_at)
		`.execute(db);
	}

	// Drop partial indexes for comments
	await sql`DROP INDEX IF EXISTS idx_comments_pending`.execute(db);
	await sql`DROP INDEX IF EXISTS idx_comments_approved`.execute(db);
	await sql`DROP INDEX IF EXISTS idx_comments_spam`.execute(db);
	await sql`DROP INDEX IF EXISTS idx_comments_trash`.execute(db);
}

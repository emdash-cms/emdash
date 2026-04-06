import type { Kysely } from "kysely";
import { sql } from "kysely";

import { listTablesLike } from "../dialect-helpers.js";

/**
 * Migration: Add published_at composite index for frontend listing queries
 *
 * Addresses GitHub issue #277: Frontend listing query full table scans.
 *
 * Changes:
 * 1. Adds composite index (deleted_at, published_at DESC, id DESC) to all ec_* tables
 * 2. Adds composite indexes to _emdash_redirects for efficient redirect matching
 *
 * Impact: Eliminates full table scans for frontend listing queries that order by published_at.
 * Related: PR #214, migration 033 (added updated_at and created_at composite indexes)
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	const tableNames = await listTablesLike(db, "ec_%");

	for (const tableName of tableNames) {
		const table = { name: tableName };

		// Composite index for published-at ordering: WHERE deleted_at IS NULL ORDER BY published_at DESC
		await sql`
			CREATE INDEX ${sql.ref(`idx_${table.name}_deleted_published_id`)}
			ON ${sql.ref(table.name)} (deleted_at, published_at DESC, id DESC)
		`.execute(db);
	}

	// Add indexes for _emdash_redirects table to optimize redirect lookups
	// These indexes cover the common query pattern: WHERE enabled = 1 AND (is_pattern = 0 OR is_pattern = 1)
	await sql`
		CREATE INDEX idx_redirects_enabled_pattern
		ON _emdash_redirects (enabled, is_pattern)
	`.execute(db);

	await sql`
		CREATE INDEX idx_redirects_source_enabled
		ON _emdash_redirects (source, enabled, is_pattern)
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	const tableNames = await listTablesLike(db, "ec_%");

	for (const tableName of tableNames) {
		const table = { name: tableName };

		// Drop published_at composite index
		await sql`DROP INDEX IF EXISTS ${sql.ref(`idx_${table.name}_deleted_published_id`)}`.execute(db);
	}

	// Drop redirect table indexes
	await sql`DROP INDEX IF EXISTS idx_redirects_enabled_pattern`.execute(db);
	await sql`DROP INDEX IF EXISTS idx_redirects_source_enabled`.execute(db);
}

import type { Kysely } from "kysely";
import { sql } from "kysely";

import { isSqlite } from "../dialect-helpers.js";

interface ColumnInfo {
	name: string;
}

interface IndexInfo {
	name: string;
}

/**
 * Migration: Add registry fields to _plugin_state
 *
 * Extends the marketplace columns added in 022 to support the
 * experimental decentralized plugin registry (see RFC #694). Rather
 * than introducing a separate `_registry_plugin_state` table, we
 * reuse the same row shape and distinguish registry installs via the
 * existing `source` column (now `'config' | 'marketplace' | 'registry'`).
 *
 * Registry plugins are addressed by `(publisher_did, slug)` in their
 * lexicon records but stored under a hashed, opaque `plugin_id` for
 * runtime compatibility -- see `packages/core/src/registry/plugin-id.ts`.
 * The `(publisher_did, slug)` pair is preserved here for update
 * resolution against the currently configured aggregator and for admin
 * UI rendering ("by @example.dev").
 *
 * All new columns are nullable; existing marketplace and config rows
 * keep working unchanged.
 *
 * Idempotency: D1 and SQLite don't honor the migration runner's
 * advisory lock, so a partial re-apply (cold start race between two
 * isolates, retry after a connection drop) can re-enter this `up`
 * function with the columns or index already in place. Each step
 * checks before adding to keep the migration safe under partial
 * re-application. The same pattern is used in 019_i18n.ts.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	if (isSqlite(db)) {
		await upSqlite(db);
	} else {
		await upPostgres(db);
	}
}

async function upSqlite(db: Kysely<unknown>): Promise<void> {
	const cols = await sql<ColumnInfo>`PRAGMA table_info(_plugin_state)`.execute(db);
	const colNames = new Set(cols.rows.map((c) => c.name));

	if (!colNames.has("registry_publisher_did")) {
		await sql`
			ALTER TABLE _plugin_state
			ADD COLUMN registry_publisher_did TEXT
		`.execute(db);
	}

	if (!colNames.has("registry_slug")) {
		await sql`
			ALTER TABLE _plugin_state
			ADD COLUMN registry_slug TEXT
		`.execute(db);
	}

	const indexes = await sql<IndexInfo>`PRAGMA index_list(_plugin_state)`.execute(db);
	const indexNames = new Set(indexes.rows.map((i) => i.name));

	if (!indexNames.has("idx_plugin_state_registry")) {
		await sql`
			CREATE INDEX idx_plugin_state_registry
			ON _plugin_state (source)
			WHERE source = 'registry'
		`.execute(db);
	}
}

async function upPostgres(db: Kysely<unknown>): Promise<void> {
	// Scope the column check to the connection's current schema.
	// Without `table_schema = current_schema()`, a `_plugin_state` table
	// in another schema (per-tenant Postgres, shared Postgres clusters,
	// per-test schemas) makes this query see columns from the wrong
	// table and skip the ALTERs entirely, leaving the active schema's
	// `_plugin_state` missing the registry columns.
	const cols = await sql<{ column_name: string }>`
		SELECT column_name FROM information_schema.columns
		WHERE table_name = '_plugin_state'
		  AND table_schema = current_schema()
	`.execute(db);
	const colNames = new Set(cols.rows.map((c) => c.column_name));

	if (!colNames.has("registry_publisher_did")) {
		await sql`
			ALTER TABLE _plugin_state
			ADD COLUMN registry_publisher_did TEXT
		`.execute(db);
	}

	if (!colNames.has("registry_slug")) {
		await sql`
			ALTER TABLE _plugin_state
			ADD COLUMN registry_slug TEXT
		`.execute(db);
	}

	// pg's CREATE INDEX IF NOT EXISTS handles the race natively; partial
	// index syntax differs from SQLite (`WHERE` is supported), so the
	// statement is otherwise identical.
	await sql`
		CREATE INDEX IF NOT EXISTS idx_plugin_state_registry
		ON _plugin_state (source)
		WHERE source = 'registry'
	`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`
		DROP INDEX IF EXISTS idx_plugin_state_registry
	`.execute(db);

	await sql`
		ALTER TABLE _plugin_state
		DROP COLUMN registry_slug
	`.execute(db);

	await sql`
		ALTER TABLE _plugin_state
		DROP COLUMN registry_publisher_did
	`.execute(db);
}

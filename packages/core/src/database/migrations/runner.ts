import { type Kysely, type Migration, type MigrationProvider, Migrator, sql } from "kysely";

import type { Database } from "../types.js";
// Import migrations statically for bundling
import * as m001 from "./001_initial.js";
import * as m002 from "./002_media_status.js";
import * as m003 from "./003_schema_registry.js";
import * as m004 from "./004_plugins.js";
import * as m005 from "./005_menus.js";
import * as m006 from "./006_taxonomy_defs.js";
import * as m007 from "./007_widgets.js";
import * as m008 from "./008_auth.js";
import * as m009 from "./009_user_disabled.js";
import * as m011 from "./011_sections.js";
import * as m012 from "./012_search.js";
import * as m013 from "./013_scheduled_publishing.js";
import * as m014 from "./014_draft_revisions.js";
import * as m015 from "./015_indexes.js";
import * as m016 from "./016_api_tokens.js";
import * as m017 from "./017_authorization_codes.js";
import * as m018 from "./018_seo.js";
import * as m019 from "./019_i18n.js";
import * as m020 from "./020_collection_url_pattern.js";
import * as m021 from "./021_remove_section_categories.js";
import * as m022 from "./022_marketplace_plugin_state.js";
import * as m023 from "./023_plugin_metadata.js";
import * as m024 from "./024_media_placeholders.js";
import * as m025 from "./025_oauth_clients.js";
import * as m026 from "./026_cron_tasks.js";
import * as m027 from "./027_comments.js";
import * as m028 from "./028_drop_author_url.js";
import * as m029 from "./029_redirects.js";
import * as m030 from "./030_widen_scheduled_index.js";
import * as m031 from "./031_bylines.js";
import * as m032 from "./032_rate_limits.js";
import * as m033 from "./033_optimize_content_indexes.js";
import * as m034 from "./034_published_at_index.js";
import * as m035 from "./035_bounded_404_log.js";
import * as m036 from "./036_credential_algorithm.js";

const MIGRATIONS: Readonly<Record<string, Migration>> = Object.freeze({
	"001_initial": m001,
	"002_media_status": m002,
	"003_schema_registry": m003,
	"004_plugins": m004,
	"005_menus": m005,
	"006_taxonomy_defs": m006,
	"007_widgets": m007,
	"008_auth": m008,
	"009_user_disabled": m009,
	"011_sections": m011,
	"012_search": m012,
	"013_scheduled_publishing": m013,
	"014_draft_revisions": m014,
	"015_indexes": m015,
	"016_api_tokens": m016,
	"017_authorization_codes": m017,
	"018_seo": m018,
	"019_i18n": m019,
	"020_collection_url_pattern": m020,
	"021_remove_section_categories": m021,
	"022_marketplace_plugin_state": m022,
	"023_plugin_metadata": m023,
	"024_media_placeholders": m024,
	"025_oauth_clients": m025,
	"026_cron_tasks": m026,
	"027_comments": m027,
	"028_drop_author_url": m028,
	"029_redirects": m029,
	"030_widen_scheduled_index": m030,
	"031_bylines": m031,
	"032_rate_limits": m032,
	"033_optimize_content_indexes": m033,
	"034_published_at_index": m034,
	"035_bounded_404_log": m035,
	"036_credential_algorithm": m036,
});

/** Total number of registered migrations. Exported for use in tests. */
export const MIGRATION_COUNT = Object.keys(MIGRATIONS).length;

/**
 * Migration provider that uses statically imported migrations.
 * This approach works well with bundlers and avoids filesystem access.
 */
class StaticMigrationProvider implements MigrationProvider {
	async getMigrations(): Promise<Record<string, Migration>> {
		return MIGRATIONS;
	}
}

export interface MigrationStatus {
	applied: string[];
	pending: string[];
}

/** Custom migration table name */
const MIGRATION_TABLE = "_emdash_migrations";
const MIGRATION_LOCK_TABLE = "_emdash_migrations_lock";

/**
 * Get migration status
 */
export async function getMigrationStatus(db: Kysely<Database>): Promise<MigrationStatus> {
	const migrator = new Migrator({
		db,
		provider: new StaticMigrationProvider(),
		migrationTableName: MIGRATION_TABLE,
		migrationLockTableName: MIGRATION_LOCK_TABLE,
	});

	const migrations = await migrator.getMigrations();

	const applied: string[] = [];
	const pending: string[] = [];

	for (const migration of migrations) {
		if (migration.executedAt) {
			applied.push(migration.name);
		} else {
			pending.push(migration.name);
		}
	}

	return { applied, pending };
}

/** Pattern for escaping special regex characters. Matches the shared helper in `database/repositories/content.ts`. */
const REGEX_ESCAPE_PATTERN = /[.*+?^${}()|[\]\\]/g;

/** Escape special regex characters so a string can be embedded literally in `new RegExp()`. */
function escapeRegExp(value: string): string {
	return value.replace(REGEX_ESCAPE_PATTERN, "\\$&");
}

/**
 * Pattern used to detect the concurrent-migration race. The Kysely
 * `SqliteAdapter.acquireMigrationLock` is a no-op (inherited by `kysely-d1`
 * and our `EmDashD1Dialect`), so two isolates running migrations against the
 * same database can both attempt `INSERT INTO _emdash_migrations` for the
 * same migration name. The losing insert fails with a UNIQUE constraint
 * error, which is benign: the other isolate is applying the same schema.
 *
 * We match on the table name (not the full error text) because different
 * SQLite drivers phrase the message differently
 * (`UNIQUE constraint failed: _emdash_migrations.name` for better-sqlite3,
 * `D1_ERROR: UNIQUE constraint failed: _emdash_migrations.name: SQLITE_CONSTRAINT`
 * for D1, etc.). The pattern is built from `MIGRATION_TABLE` so a rename
 * cannot silently disable race detection.
 */
const MIGRATION_RACE_PATTERN = new RegExp(
	`UNIQUE constraint failed: ${escapeRegExp(MIGRATION_TABLE)}\\.name`,
	"i",
);

/** How long to wait for a concurrent migrator to finish before giving up. */
const MIGRATION_RACE_WAIT_MS = 10_000;
/** Polling interval while waiting for a concurrent migrator. */
const MIGRATION_RACE_POLL_MS = 100;

/**
 * Pattern used to detect "table does not exist" errors across the dialects
 * EmDash supports. The phrasing differs by driver:
 *
 *   - better-sqlite3: `no such table: _emdash_migrations`
 *   - D1:             `D1_ERROR: no such table: _emdash_migrations: SQLITE_ERROR`
 *   - PostgreSQL:     `relation "_emdash_migrations" does not exist`
 *                     (also occasionally `table "_emdash_migrations" does not exist`)
 *
 * We deliberately match on the migration table name (rather than using the
 * generic `isMissingTableError` helper) so an unexpected missing-table error
 * naming a different table — implausible today since
 * `getAppliedMigrationCount` only references `MIGRATION_TABLE`, but cheap
 * insurance against future edits — is not silently swallowed. The pattern is
 * built from `MIGRATION_TABLE` so a rename cannot drift.
 */
const MIGRATION_TABLE_MISSING_PATTERN = new RegExp(
	`(?:no such table:\\s*${escapeRegExp(MIGRATION_TABLE)}\\b` +
		`|(?:relation|table)\\s+"?${escapeRegExp(MIGRATION_TABLE)}"?\\s+does(?:n't| not) exist\\b)`,
	"i",
);

/**
 * Read the count of applied migrations.
 *
 * Returns `null` only when the migration table does not exist yet (which is
 * the normal state on a fresh database before the first migration runs).
 * Any other error is rethrown so callers — particularly
 * `waitForConcurrentMigrator` — don't silently mask connection failures,
 * permission errors, or other unexpected driver problems behind a 10s wait
 * and a bogus "we're done" verdict.
 */
async function getAppliedMigrationCount(db: Kysely<Database>): Promise<number | null> {
	try {
		const result = await sql<{ count: number }>`
			SELECT COUNT(*) as count FROM ${sql.ref(MIGRATION_TABLE)}
		`.execute(db);
		return Number(result.rows[0]?.count ?? 0);
	} catch (error) {
		if (MIGRATION_TABLE_MISSING_PATTERN.test(deepErrorMessage(error))) {
			return null;
		}
		throw error;
	}
}

/**
 * Wait for a concurrent migrator to finish applying all migrations.
 *
 * Resolves to `true` once the migration table contains at least
 * `MIGRATION_COUNT` rows (i.e. every migration this build knows about has
 * been recorded), `false` if the deadline elapses first. We use `>=` rather
 * than `===` so that an old isolate observing a database that has already
 * been migrated by a newer build still treats the wait as settled instead
 * of timing out.
 */
async function waitForConcurrentMigrator(db: Kysely<Database>): Promise<boolean> {
	const deadline = Date.now() + MIGRATION_RACE_WAIT_MS;
	while (Date.now() < deadline) {
		const count = await getAppliedMigrationCount(db);
		if (count !== null && count >= MIGRATION_COUNT) {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, MIGRATION_RACE_POLL_MS));
	}
	const finalCount = await getAppliedMigrationCount(db);
	return finalCount !== null && finalCount >= MIGRATION_COUNT;
}

/** Extract the deepest error message available from a thrown value. */
function deepErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		const own = error.message ?? "";
		if (error.cause) {
			const causeMsg = deepErrorMessage(error.cause);
			return own ? `${own}: ${causeMsg}` : causeMsg;
		}
		return own;
	}
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

/**
 * Run all pending migrations.
 *
 * Includes a fast-path: if the migration table already exists and contains
 * at least MIGRATION_COUNT rows, all migrations this build knows about have
 * been applied and we can skip the Kysely Migrator entirely. This avoids
 * the expensive `pragma_table_info` introspection that Kysely runs for
 * every table in the database (twice!) just to check if the migration
 * tables exist. On D1 with ~57 tables, that's ~116 queries saved per init.
 *
 * Concurrent-migration safety: the Kysely Migrator's `acquireMigrationLock`
 * is a no-op for SQLite (and therefore D1), so two callers running this
 * concurrently against the same database will both try to apply pending
 * migrations. SQLite serializes the writes, but the loser still surfaces a
 * `UNIQUE constraint failed: _emdash_migrations.name` error. We treat that
 * specific error as benign: another caller is already applying the same
 * schema. We wait for the concurrent migrator to finish, then return
 * success. This matches the user-observable expectation that running
 * migrations twice in a row is a no-op.
 */
export async function runMigrations(db: Kysely<Database>): Promise<{ applied: string[] }> {
	// Fast path: check if all migrations are already applied.
	// A single cheap query vs the Migrator's full schema introspection.
	// We use `>=` rather than `===` so a database with extra rows from a
	// newer build (e.g. mid-deploy old isolate, or downgrade) still skips
	// the migrator instead of falling through to the race-recovery path
	// unnecessarily.
	const initialCount = await getAppliedMigrationCount(db);
	if (initialCount !== null && initialCount >= MIGRATION_COUNT) {
		return { applied: [] };
	}

	const migrator = new Migrator({
		db,
		provider: new StaticMigrationProvider(),
		migrationTableName: MIGRATION_TABLE,
		migrationLockTableName: MIGRATION_LOCK_TABLE,
	});

	const { error, results } = await migrator.migrateToLatest();

	const applied = results?.filter((r) => r.status === "Success").map((r) => r.migrationName) ?? [];

	if (error) {
		// Walk error.cause to get the underlying driver message — Kysely
		// often wraps with an empty top-level message.
		const msg = deepErrorMessage(error);
		const failedMigration = results?.find((r) => r.status === "Error");

		// Concurrent-migration race: another caller is applying (or just
		// applied) the same migration. Wait for it to finish, then verify
		// the schema is fully migrated and treat as success.
		if (MIGRATION_RACE_PATTERN.test(msg)) {
			const settled = await waitForConcurrentMigrator(db);
			if (settled) {
				return { applied };
			}
		}

		const failedSuffix = failedMigration ? ` (migration: ${failedMigration.migrationName})` : "";
		throw new Error(`Migration failed: ${msg || "unknown error"}${failedSuffix}`);
	}

	return { applied };
}

/**
 * Rollback the last migration
 */
export async function rollbackMigration(
	db: Kysely<Database>,
): Promise<{ rolledBack: string | null }> {
	const migrator = new Migrator({
		db,
		provider: new StaticMigrationProvider(),
		migrationTableName: MIGRATION_TABLE,
		migrationLockTableName: MIGRATION_LOCK_TABLE,
	});

	const { error, results } = await migrator.migrateDown();

	const rolledBack = results?.[0]?.status === "Success" ? results[0].migrationName : null;

	if (error) {
		const msg = error instanceof Error ? error.message : JSON.stringify(error);
		throw new Error(`Rollback failed: ${msg}`);
	}

	return { rolledBack };
}

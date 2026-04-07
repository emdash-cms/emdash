import { type Kysely, type Migration, type MigrationProvider, Migrator } from "kysely";

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

/**
 * Run all pending migrations
 */
export async function runMigrations(db: Kysely<Database>): Promise<{ applied: string[] }> {
	const migrator = new Migrator({
		db,
		provider: new StaticMigrationProvider(),
		migrationTableName: MIGRATION_TABLE,
		migrationLockTableName: MIGRATION_LOCK_TABLE,
	});

	const { error, results } = await migrator.migrateToLatest();

	const applied = results?.filter((r) => r.status === "Success").map((r) => r.migrationName) ?? [];

	if (error) {
		// Kysely sometimes wraps errors with an empty message. Check cause and
		// failed migration results for the real error.
		let msg = error instanceof Error ? error.message : JSON.stringify(error);
		if (!msg && error instanceof Error && error.cause) {
			msg = error.cause instanceof Error ? error.cause.message : JSON.stringify(error.cause);
		}
		const failedMigration = results?.find((r) => r.status === "Error");
		if (failedMigration) {
			msg = `${msg || "unknown error"} (migration: ${failedMigration.migrationName})`;
		}
		throw new Error(`Migration failed: ${msg}`);
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

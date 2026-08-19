/**
 * emdash/db
 *
 * Database adapters for EmDash CMS.
 * Use these in astro.config.mjs to configure the database.
 *
 * @example
 * ```ts
 * import emdash from "emdash/astro";
 * import { sqlite } from "emdash/db";
 *
 * export default defineConfig({
 *   integrations: [
 *     emdash({
 *       database: sqlite({ url: "file:./data.db" }),
 *     }),
 *   ],
 * });
 * ```
 */

export { sqlite, libsql, postgres } from "./adapters.js";
export type {
	DatabaseDescriptor,
	DatabaseDialectType,
	SqliteConfig,
	LibsqlConfig,
	PostgresConfig,
	CollectionDeletionGuardInput,
	CollectionDeletionGuardResult,
	ExecuteCollectionDeletionGuard,
} from "./adapters.js";

// Migration utilities (used by playground, preview, and custom deployment scripts)
export {
	runMigrations,
	getMigrationStatus,
	getExactMigrationStatus,
	rollbackMigration,
	MIGRATION_NAMES,
} from "../database/migrations/runner.js";
export type { MigrationStatus, ExactMigrationStatus } from "../database/migrations/runner.js";

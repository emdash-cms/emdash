// `createDatabase` is intentionally not re-exported here: it lives in
// `connection.ts`, which statically imports `better-sqlite3`. See #947.
export { EmDashDatabaseError } from "./errors.js";
export type { DatabaseConfig } from "./connection.js";
export {
	runMigrations,
	getMigrationStatus,
	getExactMigrationStatus,
	rollbackMigration,
	MIGRATION_NAMES,
} from "./migrations/runner.js";
export type { MigrationStatus, ExactMigrationStatus } from "./migrations/runner.js";
export type * from "./types.js";

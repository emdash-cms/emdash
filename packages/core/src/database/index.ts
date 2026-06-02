// `createDatabase` is intentionally not re-exported here: it lives in
// `connection.ts`, which statically imports `better-sqlite3`. See #947.
export { EmDashDatabaseError } from "./errors.js";
export type { DatabaseConfig } from "./connection.js";
export { runMigrations, getMigrationStatus, rollbackMigration } from "./migrations/runner.js";
export type { MigrationStatus } from "./migrations/runner.js";
export type * from "./types.js";

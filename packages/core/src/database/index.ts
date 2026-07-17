// `createDatabase` is intentionally not re-exported here: it lives in
// `connection.ts`, which statically imports `node:sqlite` — a Node-only
// builtin that must not load in non-Node runtimes (e.g. workerd). See #947.
export { EmDashDatabaseError } from "./errors.js";
export type { DatabaseConfig } from "./connection.js";
export { runMigrations, getMigrationStatus, rollbackMigration } from "./migrations/runner.js";
export type { MigrationStatus } from "./migrations/runner.js";
export type * from "./types.js";

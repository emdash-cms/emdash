import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { Kysely, PostgresDialect, SqliteDialect } from "kysely";
import { Pool } from "pg";
import { describe } from "vitest";

import { getMigrationStatus, runMigrations } from "../../src/database/migrations/runner.js";
import type { MigrationStatus } from "../../src/database/migrations/runner.js";
import type { Database as DatabaseSchema } from "../../src/database/types.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { resetTaxonomyDefsCacheForTests } from "../../src/taxonomies/index.js";

/**
 * Clear the isolate-wide, schema-derived caches that live on globalThis and
 * therefore persist across tests within a vitest worker. A freshly created
 * test database must never be served another database's cached taxonomy
 * definitions, so we reset every time a new test DB is created.
 *
 * Note: we deliberately don't import from `../../src/loader.js` here — several
 * test files `vi.mock` that module to stub `getDb`, and pulling another export
 * through this shared util would blow up under those mocks. The loader's own
 * taxonomy-names cache predates this util and is reset via its public path.
 */
function resetSchemaCachesForTests(): void {
	resetTaxonomyDefsCacheForTests();
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * PostgreSQL connection string for tests.
 * When set, Postgres tests run; when absent, they're skipped.
 */
export const PG_CONNECTION_STRING = process.env.EMDASH_TEST_PG ?? "";

/**
 * Whether a Postgres test database is available.
 */
export const hasPgTestDatabase = PG_CONNECTION_STRING.length > 0;

// ---------------------------------------------------------------------------
// SQLite helpers (unchanged)
// ---------------------------------------------------------------------------

/**
 * Create an in-memory SQLite database for testing
 */
export function createTestDatabase(): Kysely<DatabaseSchema> {
	resetSchemaCachesForTests();
	const sqlite = new Database(":memory:");

	return new Kysely<DatabaseSchema>({
		dialect: new SqliteDialect({
			database: sqlite,
		}),
	});
}

/**
 * Setup a test database with migrations run
 */
export async function setupTestDatabase(): Promise<Kysely<DatabaseSchema>> {
	const db = createTestDatabase();
	await runMigrations(db);
	return db;
}

/**
 * Setup a test database with standard test collections (post, page)
 * This creates the ec_post and ec_page tables with title and content fields
 */
export async function setupTestDatabaseWithCollections(): Promise<Kysely<DatabaseSchema>> {
	const db = await setupTestDatabase();
	const registry = new SchemaRegistry(db);

	// Create post collection
	await registry.createCollection({
		slug: "post",
		label: "Posts",
		labelSingular: "Post",
	});
	await registry.createField("post", {
		slug: "title",
		label: "Title",
		type: "string",
	});
	await registry.createField("post", {
		slug: "content",
		label: "Content",
		type: "portableText",
	});

	// Create page collection
	await registry.createCollection({
		slug: "page",
		label: "Pages",
		labelSingular: "Page",
	});
	await registry.createField("page", {
		slug: "title",
		label: "Title",
		type: "string",
	});
	await registry.createField("page", {
		slug: "content",
		label: "Content",
		type: "portableText",
	});

	return db;
}

/**
 * Cleanup and destroy a test database
 */
export async function teardownTestDatabase(db: Kysely<DatabaseSchema>): Promise<void> {
	await db.destroy();
}

// ---------------------------------------------------------------------------
// PostgreSQL helpers
// ---------------------------------------------------------------------------

// --- Per-worker database isolation -----------------------------------------
//
// Vitest runs test files in parallel worker processes that all share one
// Postgres server. The original harness isolated each test in its own *schema*
// inside one shared database. That breaks down under parallelism: Kysely's
// migrator introspects the catalog database-wide (`pg_namespace`, `pg_class`)
// with no schema filter, so a migration in one worker sees — and races against
// — the sibling schemas other workers are concurrently creating and dropping.
// The result is intermittent `schema/relation/column "test_…" does not exist`
// failures during setup (issue #1333).
//
// Postgres catalogs are *per database*, so giving each worker its own database
// fully isolates introspection. Within a worker, schemas are still created and
// dropped per test, but sequentially (Vitest runs one file at a time per
// worker and awaits hooks in order), so there is no concurrent catalog churn.

/** Validate an identifier we must interpolate into DDL (no bind params allowed). */
function assertSafeIdentifier(id: string): void {
	if (!/^[a-z][a-z0-9_]*$/.test(id) || id.length > 63) {
		throw new Error(`Unsafe SQL identifier: ${id}`);
	}
}

/**
 * Name of the Postgres database dedicated to the current Vitest worker.
 * `VITEST_POOL_ID` is the stable worker-slot id (reused across files within a
 * worker); we fall back to the pid so the harness still works outside Vitest.
 */
function workerDatabaseName(): string {
	const raw = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? String(process.pid);
	const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "_");
	const name = `emdash_test_w_${slug}`;
	assertSafeIdentifier(name);
	return name;
}

/** Swap the database in a connection string for the per-worker database. */
function withDatabase(connectionString: string, database: string): string {
	const url = new URL(connectionString);
	url.pathname = `/${database}`;
	return url.toString();
}

/**
 * Ensure the per-worker database exists and resolve its connection string.
 * Memoised per process so the create-database round-trip happens once.
 */
let workerConnPromise: Promise<string> | null = null;
function getWorkerConnectionString(): Promise<string> {
	if (!workerConnPromise) {
		workerConnPromise = (async () => {
			const dbName = workerDatabaseName();
			// Connect to the maintenance database from the original connection
			// string to issue CREATE DATABASE (which cannot run while connected
			// to its target, nor inside a transaction).
			const admin = new Pool({ connectionString: PG_CONNECTION_STRING, max: 1 });
			try {
				const { rows } = await admin.query<{ exists: number }>(
					"SELECT 1 AS exists FROM pg_database WHERE datname = $1",
					[dbName],
				);
				if (rows.length === 0) {
					// Concurrent CREATE DATABASE calls (different worker names) can
					// still collide on the template1 lock; retry a few times.
					await createDatabaseWithRetry(admin, dbName);
				}
			} finally {
				await admin.end();
			}
			return withDatabase(PG_CONNECTION_STRING, dbName);
		})();
	}
	return workerConnPromise;
}

async function createDatabaseWithRetry(admin: Pool, dbName: string): Promise<void> {
	for (let attempt = 0; attempt < 10; attempt++) {
		try {
			await admin.query(`CREATE DATABASE ${dbName}`);
			return;
		} catch (error) {
			const msg = String(error instanceof Error ? error.message : error);
			// 42P04 = duplicate_database (another check-then-create raced us).
			if (/already exists|duplicate_database/i.test(msg)) return;
			// "source database … is being accessed by other users" — template1
			// is locked by another concurrent CREATE DATABASE; back off and retry.
			if (attempt < 9 && /being accessed by other users/i.test(msg)) {
				await new Promise((resolve) => setTimeout(resolve, 50 + attempt * 50));
				continue;
			}
			throw error;
		}
	}
}

/**
 * Shared pool for the current worker's Postgres database. One pool per test
 * process, used for schema create/drop. Created lazily.
 */
let sharedPool: Pool | null = null;

async function getSharedPool(): Promise<Pool> {
	if (!sharedPool) {
		const connectionString = await getWorkerConnectionString();
		sharedPool = new Pool({ connectionString, max: 10 });
	}
	return sharedPool;
}

/**
 * Generate a unique schema name for test isolation.
 *
 * Unique within the worker database via a monotonic counter (clock resolution
 * independent) plus crypto entropy, so two contexts in the same process can
 * never collide on a name. PostgreSQL identifiers are capped at 63 bytes; this
 * stays well under.
 */
let schemaCounter = 0;
function uniqueSchemaName(): string {
	const seq = (schemaCounter++).toString(36);
	const rand = randomUUID().replace(/-/g, "").slice(0, 12);
	return `test_${seq}_${rand}`;
}

export interface PgTestContext {
	db: Kysely<DatabaseSchema>;
	schemaName: string;
}

/**
 * Create an isolated Postgres database for a single test.
 *
 * Each call creates a unique schema inside the worker's database and returns a
 * Kysely instance whose search_path is set to that schema. Tables are fully
 * isolated.
 *
 * Call `teardownTestPostgresDatabase()` in afterEach to drop the schema.
 */
export async function createTestPostgresDatabase(): Promise<PgTestContext> {
	resetSchemaCachesForTests();
	const connectionString = await getWorkerConnectionString();
	const pool = await getSharedPool();
	const schemaName = uniqueSchemaName();

	// Create the isolated schema using a raw connection
	const client = await pool.connect();
	try {
		await client.query(`CREATE SCHEMA ${schemaName}`);
	} finally {
		client.release();
	}

	// Create a Kysely instance that targets this schema.
	// Test schema comes first so CREATE TABLE goes there.
	// public is included for Postgres system functions and extensions.
	const testPool = new Pool({
		connectionString,
		max: 5,
		options: `-c search_path=${schemaName},public`,
	});

	const db = new Kysely<DatabaseSchema>({
		dialect: new PostgresDialect({ pool: testPool }),
	});

	return { db, schemaName };
}

/**
 * Setup a Postgres test database with migrations run.
 */
export async function setupTestPostgresDatabase(): Promise<PgTestContext> {
	const ctx = await createTestPostgresDatabase();
	await runMigrations(ctx.db, { migrationTableSchema: ctx.schemaName });
	return ctx;
}

/**
 * Setup a Postgres test database with standard test collections (post, page).
 */
export async function setupTestPostgresDatabaseWithCollections(): Promise<PgTestContext> {
	const ctx = await setupTestPostgresDatabase();
	const registry = new SchemaRegistry(ctx.db);

	await registry.createCollection({
		slug: "post",
		label: "Posts",
		labelSingular: "Post",
	});
	await registry.createField("post", {
		slug: "title",
		label: "Title",
		type: "string",
	});
	await registry.createField("post", {
		slug: "content",
		label: "Content",
		type: "portableText",
	});

	await registry.createCollection({
		slug: "page",
		label: "Pages",
		labelSingular: "Page",
	});
	await registry.createField("page", {
		slug: "title",
		label: "Title",
		type: "string",
	});
	await registry.createField("page", {
		slug: "content",
		label: "Content",
		type: "portableText",
	});

	return ctx;
}

/**
 * Tear down a Postgres test database — drops the schema and closes the pool.
 */
export async function teardownTestPostgresDatabase(ctx: PgTestContext): Promise<void> {
	// Destroy the test pool first
	await ctx.db.destroy();

	// Drop the schema using the shared pool
	const pool = await getSharedPool();
	const client = await pool.connect();
	try {
		await client.query(`DROP SCHEMA IF EXISTS ${ctx.schemaName} CASCADE`);
	} finally {
		client.release();
	}
}

/**
 * Shut down the shared Postgres pool. Call once at the end of the test run.
 */
export async function destroySharedPool(): Promise<void> {
	if (sharedPool) {
		await sharedPool.end();
		sharedPool = null;
	}
}

// ---------------------------------------------------------------------------
// Dialect-parametric test helpers
// ---------------------------------------------------------------------------

export type DialectName = "sqlite" | "postgres";

export interface DialectTestContext {
	db: Kysely<DatabaseSchema>;
	dialect: DialectName;
	/** Only present for Postgres — needed for teardown */
	pgCtx?: PgTestContext;
}

/**
 * Create a bare test database for a given dialect (no migrations).
 */
export async function createForDialect(dialect: DialectName): Promise<DialectTestContext> {
	if (dialect === "postgres") {
		const pgCtx = await createTestPostgresDatabase();
		return { db: pgCtx.db, dialect, pgCtx };
	}
	const db = createTestDatabase();
	return { db, dialect };
}

/**
 * Create a test database for a given dialect (with migrations).
 */
export async function setupForDialect(dialect: DialectName): Promise<DialectTestContext> {
	if (dialect === "postgres") {
		const pgCtx = await setupTestDatabase_pg();
		return { db: pgCtx.db, dialect, pgCtx };
	}
	const db = await setupTestDatabase();
	return { db, dialect };
}

/**
 * Create a test database with collections for a given dialect.
 */
export async function setupForDialectWithCollections(
	dialect: DialectName,
): Promise<DialectTestContext> {
	if (dialect === "postgres") {
		const pgCtx = await setupTestPostgresDatabaseWithCollections();
		return { db: pgCtx.db, dialect, pgCtx };
	}
	const db = await setupTestDatabaseWithCollections();
	return { db, dialect };
}

/**
 * Tear down a test database for any dialect.
 */
export async function teardownForDialect(ctx: DialectTestContext | undefined): Promise<void> {
	if (!ctx) return;
	if (ctx.pgCtx) {
		await teardownTestPostgresDatabase(ctx.pgCtx);
	} else {
		await teardownTestDatabase(ctx.db);
	}
}

export function runMigrationsForDialect(ctx: DialectTestContext): Promise<{ applied: string[] }> {
	return runMigrations(ctx.db, { migrationTableSchema: ctx.pgCtx?.schemaName });
}

export function getMigrationStatusForDialect(ctx: DialectTestContext): Promise<MigrationStatus> {
	return getMigrationStatus(ctx.db, { migrationTableSchema: ctx.pgCtx?.schemaName });
}

// Private alias to avoid name collision
const setupTestDatabase_pg = setupTestPostgresDatabase;

/**
 * Run a describe block once per available dialect.
 *
 * When EMDASH_TEST_PG is not set, only SQLite runs.
 * When set, the suite runs for both SQLite and Postgres.
 *
 * @example
 * ```ts
 * describeEachDialect("Migrations", (dialectName) => {
 *   let ctx: DialectTestContext;
 *   beforeEach(async () => { ctx = await setupForDialect(dialectName); });
 *   afterEach(async () => { await teardownForDialect(ctx); });
 *
 *   it("creates tables", async () => {
 *     // ctx.db works with either dialect
 *   });
 * });
 * ```
 */
export function describeEachDialect(name: string, fn: (dialect: DialectName) => void): void {
	const dialects: DialectName[] = ["sqlite"];
	if (hasPgTestDatabase) {
		dialects.push("postgres");
	}

	for (const dialect of dialects) {
		describe(`${name} [${dialect}]`, () => {
			fn(dialect);
		});
	}
}

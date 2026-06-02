import Database from "better-sqlite3";
import { Kysely, PostgresDialect, SqliteDialect } from "kysely";
import { Pool } from "pg";
import { describe } from "vitest";

import { getMigrationStatus, runMigrations } from "../../src/database/migrations/runner.js";
import type { MigrationStatus } from "../../src/database/migrations/runner.js";
import type { Database as DatabaseSchema } from "../../src/database/types.js";
import { SchemaRegistry } from "../../src/schema/registry.js";

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

/**
 * Shared pool for Postgres tests. One pool per test process, many schemas.
 * Created lazily on first call to createTestPostgresDatabase().
 */
let sharedPool: Pool | null = null;

function getSharedPool(): Pool {
	if (!sharedPool) {
		sharedPool = new Pool({
			connectionString: PG_CONNECTION_STRING,
			max: 10,
		});
	}
	return sharedPool;
}

/**
 * Generate a unique schema name for test isolation.
 * Format: test_<timestamp>_<random> — short, valid SQL identifier.
 */
function uniqueSchemaName(): string {
	const ts = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 8);
	return `test_${ts}_${rand}`;
}

export interface PgTestContext {
	db: Kysely<DatabaseSchema>;
	schemaName: string;
}

/**
 * Create an isolated Postgres database for a single test.
 *
 * Each call creates a unique schema and returns a Kysely instance
 * whose search_path is set to that schema. Tables are fully isolated.
 *
 * Call `teardownTestPostgresDatabase()` in afterEach to drop the schema.
 */
export async function createTestPostgresDatabase(): Promise<PgTestContext> {
	const pool = getSharedPool();
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
		connectionString: PG_CONNECTION_STRING,
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
	const pool = getSharedPool();
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

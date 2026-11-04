/**
 * Fail-fast Postgres migration locking (#1744).
 *
 * On Cloudflare Workers, EmDash's per-isolate init lock cannot coordinate
 * across isolates, so multiple isolates can run `runMigrations` against the
 * same Postgres database concurrently. Kysely's stock adapter serializes
 * them with a *blocking* `pg_advisory_xact_lock` — when a pending migration
 * keeps failing, every cold start parks a connection inside Postgres
 * waiting for the lock and then retries the same failing migration.
 *
 * These tests run only when EMDASH_TEST_PG is set. They simulate the
 * concurrent isolate by holding the advisory lock from a second connection
 * of the same pool (a distinct Postgres session, like another isolate's
 * connection).
 */

import { sql } from "kysely";
import { describe, expect, it } from "vitest";

import {
	ConcurrentMigrationTimeoutError,
	MIGRATION_COUNT,
	runMigrations,
} from "../../../src/database/migrations/runner.js";
import {
	createTestPostgresDatabase,
	hasPgTestDatabase,
	type PgTestContext,
	setupTestPostgresDatabase,
	teardownTestPostgresDatabase,
} from "../../utils/test-db.js";

/** Kysely's migration advisory lock id (mirrored in pg-migration-lock.ts). */
const LOCK_ID = BigInt("3853314791062309107");

/**
 * Acquire the migration advisory lock on a dedicated session (a separate
 * connection from the context's pool) and hold it until `release()` is
 * called — simulating another isolate's in-flight migrator.
 */
async function holdMigrationLock(
	ctx: PgTestContext,
): Promise<{ release: () => void; done: Promise<void> }> {
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let acquired!: () => void;
	let failed!: (error: unknown) => void;
	const acquiredPromise = new Promise<void>((resolve, reject) => {
		acquired = resolve;
		failed = reject;
	});
	const done = ctx.db
		.transaction()
		.execute(async (trx) => {
			await sql`select pg_advisory_xact_lock(${sql.lit(LOCK_ID)})`.execute(trx);
			acquired();
			// Keep the transaction (and therefore the lock) open until released.
			await held;
		})
		.catch((error: unknown) => {
			failed(error);
			throw error;
		});
	await acquiredPromise;
	return { release, done };
}

describe.runIf(hasPgTestDatabase)("Fail-fast Postgres migration lock (#1744)", () => {
	it("fails fast instead of blocking when another migrator holds the lock", async () => {
		// Fresh schema, no migrations applied — the state of a database whose
		// pending migrations another isolate is (unsuccessfully) applying.
		const ctx = await createTestPostgresDatabase();
		try {
			const lock = await holdMigrationLock(ctx);
			try {
				const start = Date.now();
				// The distinct error type matters: getDatabase() exempts it from
				// the failure backoff, since the lock holder may simply be slow
				// rather than failing.
				await expect(
					runMigrations(ctx.db, { migrationTableSchema: ctx.schemaName, raceWaitMs: 300 }),
				).rejects.toThrow(ConcurrentMigrationTimeoutError);
				// The old behavior blocked inside pg_advisory_xact_lock until the
				// holder finished — i.e. forever in this test. The fail-fast path
				// must return promptly: try-lock + a bounded ~300ms poll.
				expect(Date.now() - start).toBeLessThan(5000);
			} finally {
				lock.release();
				await lock.done;
			}
		} finally {
			await teardownTestPostgresDatabase(ctx);
		}
	});

	it("treats the busy lock as success once the concurrent migrator finishes", async () => {
		// Fully migrated schema with the last migration row removed — the
		// bookkeeping state a waiter observes while another isolate applies
		// the final pending migration.
		const ctx = await setupTestPostgresDatabase();
		try {
			const lastRow = await sql<{ name: string; timestamp: string }>`
				SELECT name, timestamp FROM _emdash_migrations ORDER BY name DESC LIMIT 1
			`.execute(ctx.db);
			const last = lastRow.rows[0]!;
			await sql`DELETE FROM _emdash_migrations WHERE name = ${last.name}`.execute(ctx.db);

			const lock = await holdMigrationLock(ctx);
			try {
				const migration = runMigrations(ctx.db, {
					migrationTableSchema: ctx.schemaName,
					raceWaitMs: 10_000,
				});
				// While the migrator polls for the "concurrent migrator", restore
				// the row (as if the lock holder just applied the migration)...
				await sql`
					INSERT INTO _emdash_migrations (name, timestamp)
					VALUES (${last.name}, ${last.timestamp})
				`.execute(ctx.db);
				// ...and it must settle as success without applying anything itself.
				await expect(migration).resolves.toEqual({ applied: [] });
			} finally {
				lock.release();
				await lock.done;
			}
		} finally {
			await teardownTestPostgresDatabase(ctx);
		}
	});

	it("surfaces a genuinely failing migration without queueing concurrent callers", async () => {
		// The incident shape: a pending migration that fails every attempt
		// (here: re-running 001_initial against an already-built schema).
		// Concurrent callers must all fail in bounded time — none may hang on
		// the advisory lock.
		const ctx = await setupTestPostgresDatabase();
		try {
			await sql`DELETE FROM _emdash_migrations WHERE name = '001_initial'`.execute(ctx.db);

			const start = Date.now();
			const results = await Promise.allSettled([
				runMigrations(ctx.db, { migrationTableSchema: ctx.schemaName, raceWaitMs: 500 }),
				runMigrations(ctx.db, { migrationTableSchema: ctx.schemaName, raceWaitMs: 500 }),
			]);
			expect(Date.now() - start).toBeLessThan(15_000);

			// Both reject: the migration genuinely fails, and the concurrent
			// caller either observes the busy lock (and the holder never
			// completes) or re-runs the same failing migration itself.
			expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
			// The real migration error must not be swallowed as a race.
			const messages = results.map((r) =>
				r.status === "rejected" ? String((r.reason as Error).message) : "",
			);
			expect(messages.some((m) => /Migration failed/i.test(m))).toBe(true);

			// And the bookkeeping still reflects the failure: the deleted row
			// was not silently restored.
			const count = await sql<{ count: number }>`
				SELECT COUNT(*) as count FROM _emdash_migrations
			`.execute(ctx.db);
			expect(Number(count.rows[0]?.count)).toBe(MIGRATION_COUNT - 1);
		} finally {
			await teardownTestPostgresDatabase(ctx);
		}
	});
});

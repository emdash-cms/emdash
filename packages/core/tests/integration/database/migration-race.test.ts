import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../../src/database/connection.js";
import { MIGRATION_COUNT, runMigrations } from "../../../src/database/migrations/runner.js";

/**
 * Reproduces the issue from #762: when two callers run migrations
 * concurrently against the same database (e.g. two Cloudflare Workers
 * isolates handling parallel requests during a fresh deploy), the Kysely
 * Migrator races on inserting into `_emdash_migrations` and the loser
 * throws `UNIQUE constraint failed: _emdash_migrations.name`.
 *
 * The Kysely SqliteAdapter (which D1 inherits from kysely-d1) has a no-op
 * `acquireMigrationLock`, so this race is unprotected on D1.
 *
 * We simulate the race here by pointing two independent Kysely instances
 * at the same SQLite file and starting `runMigrations` on both
 * concurrently. SQLite serializes writes, but both Migrators still race
 * on the bookkeeping insert.
 */
describe("Migration race condition (#762)", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "emdash-migration-race-"));
		dbPath = join(tmpDir, "data.db");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("should not throw when two callers run migrations concurrently", async () => {
		const dbA = createDatabase({ url: `file:${dbPath}` });
		const dbB = createDatabase({ url: `file:${dbPath}` });

		try {
			// Fire both migrators in parallel against the same database file.
			// On D1, this is what happens when two Workers isolates spin up
			// at once on first request after deploy.
			const results = await Promise.allSettled([runMigrations(dbA), runMigrations(dbB)]);

			const failures = results.filter((r) => r.status === "rejected");
			if (failures.length > 0) {
				const messages = failures.map((f) =>
					f.status === "rejected" ? String(f.reason?.message ?? f.reason) : "",
				);
				throw new Error(
					`Concurrent runMigrations should not throw, but got ${failures.length} failure(s):\n${messages.join("\n")}`,
				);
			}

			// And the DB must actually be fully migrated — we don't want a
			// fix that just swallows errors and leaves the schema half-built.
			const verifyDb = createDatabase({ url: `file:${dbPath}` });
			try {
				const row = await sql<{ count: number }>`
					SELECT COUNT(*) as count FROM _emdash_migrations
				`.execute(verifyDb);
				expect(Number(row.rows[0]?.count)).toBe(MIGRATION_COUNT);
			} finally {
				await verifyDb.destroy();
			}
		} finally {
			await dbA.destroy();
			await dbB.destroy();
		}
	});

	it("should fast-path when the migration table has more rows than this build knows about", async () => {
		// Simulates an old isolate observing a database that's already been
		// migrated by a newer build (one extra migration recorded). The
		// fast-path must treat this as "fully migrated" rather than falling
		// through to the Kysely Migrator and risking the race-recovery path.
		const db = createDatabase({ url: `file:${dbPath}` });
		try {
			await runMigrations(db);
			// Insert a phantom future migration row to simulate a newer build.
			await sql`
				INSERT INTO _emdash_migrations (name, timestamp)
				VALUES ('999_future_build', ${new Date().toISOString()})
			`.execute(db);

			// Should be a no-op via the fast-path — no errors, no extra work.
			const result = await runMigrations(db);
			expect(result.applied).toEqual([]);

			// Row count is still MIGRATION_COUNT + 1 (we didn't truncate).
			const row = await sql<{ count: number }>`
				SELECT COUNT(*) as count FROM _emdash_migrations
			`.execute(db);
			expect(Number(row.rows[0]?.count)).toBe(MIGRATION_COUNT + 1);
		} finally {
			await db.destroy();
		}
	});

	it("should still surface unrelated migration errors", async () => {
		// Exercises the non-race error path so a regression that swallows
		// real errors is caught. We migrate once, then delete a single row
		// from `_emdash_migrations` so the migrator tries to re-run that
		// migration and fails with `table ... already exists` — a non-race
		// error that must NOT be swallowed.
		const db = createDatabase({ url: `file:${dbPath}` });
		try {
			await runMigrations(db);
			await sql`DELETE FROM _emdash_migrations WHERE name = '001_initial'`.execute(db);
			await expect(runMigrations(db)).rejects.toThrow(/Migration failed/i);
		} finally {
			await db.destroy();
		}
	});
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../../src/database/connection.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";

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
		} finally {
			await dbA.destroy();
			await dbB.destroy();
		}
	});
});

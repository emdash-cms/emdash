/**
 * Upgrade-path regression for the `labellers` -> `labelers` rename.
 *
 * `0001_init.sql` shipped on `main` creating a `labellers` table, then a later
 * revision renamed it in place. Editing an applied migration is invisible to
 * databases that already recorded it, so instances deployed off `main` kept
 * `labellers` while `src/` moved to querying `labelers` -> every such query
 * failed with `no such table`. The rename now lands as a forward migration.
 *
 * This test provisions the schema the way a `main` deployment had it (via the
 * `MAIN_MIGRATIONS` fixture, a frozen copy of `main`'s shipped migration set),
 * then applies the live migration set on top. `applyD1Migrations` skips
 * migrations already recorded by name, so neither frozen file is re-run —
 * exactly what happens on a real upgrade. It lives in its own file because the workers pool isolates
 * D1 storage per test file, not per test, and this scenario needs a database
 * that starts from `main`'s schema rather than the live one.
 */

import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
	MAIN_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;

describe("labellers -> labelers upgrade", () => {
	it("converges an already-migrated main database on the labelers table", async () => {
		await applyD1Migrations(testEnv.DB, testEnv.MAIN_MIGRATIONS);
		expect((await testEnv.DB.prepare(`SELECT did FROM labellers`).all()).success).toBe(true);

		const did = "did:web:labels.example.test";
		await testEnv.DB.prepare(
			`INSERT INTO labellers (did, endpoint, signing_key, signing_key_id, trusted, added_at, last_resolved_at)
			 VALUES (?, ?, ?, ?, 1, ?, ?)`,
		)
			.bind(
				did,
				"https://labels.example.test/subscribe",
				"zKey",
				`${did}#atproto_label`,
				"2026-01-01T00:00:00.000Z",
				"2026-01-01T00:00:00.000Z",
			)
			.run();

		await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);

		// The RENAME must carry the existing row across, not drop/recreate the table.
		const result = await testEnv.DB.prepare(
			`SELECT did FROM labelers WHERE trusted = 1 ORDER BY did ASC`,
		).all<{ did: string }>();
		expect(result.success).toBe(true);
		expect(result.results?.map((row) => row.did)).toContain(did);

		await expect(testEnv.DB.prepare(`SELECT did FROM labellers`).all()).rejects.toThrow();
	});
});

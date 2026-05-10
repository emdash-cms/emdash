import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../../../src/database/connection.js";
import { down, up } from "../../../../src/database/migrations/016_api_tokens.js";
import type { Database } from "../../../../src/database/types.js";

describe("016_api_tokens migration", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = createDatabase({ url: ":memory:" });

		// 016 has FKs to `users` (id), so the prerequisite table must exist.
		await db.schema
			.createTable("users")
			.addColumn("id", "text", (col) => col.primaryKey())
			.execute();
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("creates api token, oauth token, and device code tables", async () => {
		await up(db);

		const tables = await db.introspection.getTables();
		const tableNames = tables.map((t) => t.name);
		expect(tableNames).toContain("_emdash_api_tokens");
		expect(tableNames).toContain("_emdash_oauth_tokens");
		expect(tableNames).toContain("_emdash_device_codes");

		const indexes = await sql<{ name: string }>`
			SELECT name FROM sqlite_master WHERE type = 'index'
		`.execute(db);
		const indexNames = indexes.rows.map((r) => r.name);
		expect(indexNames).toContain("idx_api_tokens_token_hash");
		expect(indexNames).toContain("idx_api_tokens_user_id");
		expect(indexNames).toContain("idx_oauth_tokens_user_id");
		expect(indexNames).toContain("idx_oauth_tokens_expires");
	});

	it("reverts all added tables", async () => {
		await up(db);
		await down(db);

		const tables = await db.introspection.getTables();
		const tableNames = tables.map((t) => t.name);
		expect(tableNames).not.toContain("_emdash_api_tokens");
		expect(tableNames).not.toContain("_emdash_oauth_tokens");
		expect(tableNames).not.toContain("_emdash_device_codes");
	});

	// Regression test for #954: when an earlier attempt at `up()` partially
	// completed (e.g. the first CREATE TABLE succeeded but a subsequent
	// statement crashed with a D1 subrequest limit, isolate cancellation,
	// or transient connection error), the migration record never got
	// inserted. On the next request Kysely sees 016 still pending and
	// re-runs `up()` from the top, which previously crashed with
	// `table "_emdash_api_tokens" already exists` and blocked every
	// subsequent boot.
	//
	// `up()` must therefore be safe to re-run against a partially-applied
	// schema: any tables/indexes already in place are treated as no-ops and
	// the remaining ones are created normally.
	describe("re-run safety after a partially-applied migration (#954)", () => {
		it("is a no-op when every table and index has already been created", async () => {
			await up(db);

			// Second run must not throw — this is the exact symptom users hit
			// on Cloudflare Workers + D1 when 016 retried.
			await expect(up(db)).resolves.not.toThrow();

			// Schema is still intact.
			const tables = await db.introspection.getTables();
			const tableNames = tables.map((t) => t.name);
			expect(tableNames).toContain("_emdash_api_tokens");
			expect(tableNames).toContain("_emdash_oauth_tokens");
			expect(tableNames).toContain("_emdash_device_codes");
		});

		it("recovers when only the first tables were created before the crash", async () => {
			// Simulate a partial-apply state. Running `up()` once sets up
			// `_emdash_api_tokens` with the *exact* schema 016 produces;
			// dropping the trailing tables that 016 also creates leaves
			// the database in the same shape it would be in if `up()`
			// had crashed midway through.
			//
			// We deliberately reuse the migration's own definition for
			// `_emdash_api_tokens` rather than hand-rolling one — a
			// hand-rolled copy drifts from the migration silently if the
			// schema ever changes, so the test would still pass while
			// asserting nothing meaningful.
			await up(db);
			await db.schema.dropTable("_emdash_device_codes").execute();
			await db.schema.dropTable("_emdash_oauth_tokens").execute();

			await expect(up(db)).resolves.not.toThrow();

			const tables = await db.introspection.getTables();
			const tableNames = tables.map((t) => t.name);
			expect(tableNames).toContain("_emdash_api_tokens");
			expect(tableNames).toContain("_emdash_oauth_tokens");
			expect(tableNames).toContain("_emdash_device_codes");

			// Recovered schema must preserve 016's constraints, not just
			// table existence — a `CREATE TABLE IF NOT EXISTS` against a
			// pre-existing table is a no-op even if the new definition
			// differs, so we check the columns and constraints survived.
			const apiTokensTable = tables.find((t) => t.name === "_emdash_api_tokens");
			expect(apiTokensTable).toBeDefined();
			const columnNames = apiTokensTable?.columns.map((c) => c.name) ?? [];
			expect(columnNames).toEqual(
				expect.arrayContaining([
					"id",
					"name",
					"token_hash",
					"prefix",
					"user_id",
					"scopes",
					"expires_at",
					"last_used_at",
					"created_at",
				]),
			);

			// Indexes that 016 owns must also still be in place, including
			// the ones that the retry was responsible for re-creating.
			const indexes = await sql<{ name: string }>`
				SELECT name FROM sqlite_master WHERE type = 'index'
			`.execute(db);
			const indexNames = indexes.rows.map((r) => r.name);
			expect(indexNames).toContain("idx_api_tokens_token_hash");
			expect(indexNames).toContain("idx_api_tokens_user_id");
			expect(indexNames).toContain("idx_oauth_tokens_user_id");
			expect(indexNames).toContain("idx_oauth_tokens_expires");
		});
	});
});

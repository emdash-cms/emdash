import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../../../src/database/connection.js";
import { up as up016 } from "../../../../src/database/migrations/016_api_tokens.js";
import { down, up } from "../../../../src/database/migrations/017_authorization_codes.js";
import type { Database } from "../../../../src/database/types.js";

async function tableNames(db: Kysely<Database>): Promise<string[]> {
	const tables = await db.introspection.getTables();
	return tables.map((t) => t.name);
}

async function indexNames(db: Kysely<Database>): Promise<string[]> {
	const indexes = await sql<{ name: string }>`
		SELECT name FROM sqlite_master WHERE type = 'index'
	`.execute(db);
	return indexes.rows.map((r) => r.name);
}

async function columnNames(db: Kysely<Database>, table: string): Promise<string[]> {
	const tables = await db.introspection.getTables();
	return tables.find((t) => t.name === table)?.columns.map((c) => c.name) ?? [];
}

describe("017_authorization_codes migration", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = createDatabase({ url: ":memory:" });

		// 017 has an FK to `users` (id) and adds a column to
		// `_emdash_oauth_tokens`, which 016 creates.
		await db.schema
			.createTable("users")
			.addColumn("id", "text", (col) => col.primaryKey())
			.execute();
		await up016(db);
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("creates the authorization codes table, its index, and the client_id column", async () => {
		await up(db);

		expect(await tableNames(db)).toContain("_emdash_authorization_codes");
		expect(await indexNames(db)).toContain("idx_auth_codes_expires");
		expect(await columnNames(db, "_emdash_oauth_tokens")).toContain("client_id");
	});

	it("reverts the authorization codes table", async () => {
		await up(db);
		await down(db);

		expect(await tableNames(db)).not.toContain("_emdash_authorization_codes");
	});

	// D1 commits each DDL statement on its own and the migrator records 017 only
	// once `up()` returns, so a cut-short run leaves it pending on its own output.
	describe("re-run safety after a partially-applied migration", () => {
		it("is a no-op when every statement has already run", async () => {
			await up(db);

			await expect(up(db)).resolves.not.toThrow();

			expect(await tableNames(db)).toContain("_emdash_authorization_codes");
			expect(await indexNames(db)).toContain("idx_auth_codes_expires");
			expect(await columnNames(db, "_emdash_oauth_tokens")).toContain("client_id");
		});

		it("recovers when only the table was created before the crash", async () => {
			// Running `up()` once and undoing the trailing statements leaves
			// the table with the exact schema an interrupted run leaves.
			await up(db);
			await db.schema.dropIndex("idx_auth_codes_expires").execute();
			await sql`ALTER TABLE _emdash_oauth_tokens DROP COLUMN client_id`.execute(db);

			await expect(up(db)).resolves.not.toThrow();

			expect(await tableNames(db)).toContain("_emdash_authorization_codes");
			expect(await indexNames(db)).toContain("idx_auth_codes_expires");
			expect(await columnNames(db, "_emdash_oauth_tokens")).toContain("client_id");

			// `CREATE TABLE IF NOT EXISTS` is a no-op against an existing table
			// even when the definitions differ, so the columns are checked too.
			expect(await columnNames(db, "_emdash_authorization_codes")).toEqual(
				expect.arrayContaining([
					"code_hash",
					"client_id",
					"redirect_uri",
					"user_id",
					"scopes",
					"code_challenge",
					"code_challenge_method",
					"resource",
					"expires_at",
					"created_at",
				]),
			);
		});

		it("recovers when the table and index were created before the crash", async () => {
			await up(db);
			await sql`ALTER TABLE _emdash_oauth_tokens DROP COLUMN client_id`.execute(db);

			await expect(up(db)).resolves.not.toThrow();

			expect(await columnNames(db, "_emdash_oauth_tokens")).toContain("client_id");
		});

		// The migrator clears the migration row only once `down()` returns, so a
		// cut-short rollback leaves the table dropped and 017 still recorded.
		it("recovers when the table was already dropped by an interrupted rollback", async () => {
			await up(db);
			await down(db);

			await expect(down(db)).resolves.not.toThrow();

			expect(await tableNames(db)).not.toContain("_emdash_authorization_codes");
		});
	});
});

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../../../src/database/connection.js";
import { up } from "../../../../src/database/migrations/035_bounded_404_log.js";
import type { Database } from "../../../../src/database/types.js";

describe("035_bounded_404_log migration", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = createDatabase({ url: ":memory:" });

		// Schema as it existed before 035: path is non-unique-indexed, no hits/last_seen_at.
		await db.schema
			.createTable("_emdash_404_log")
			.addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
			.addColumn("path", "text", (col) => col.notNull())
			.addColumn("created_at", "text", (col) => col.notNull())
			.execute();

		await db.schema.createIndex("idx_404_log_path").on("_emdash_404_log").column("path").execute();
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("dedups duplicate paths and creates the unique index on a fresh run", async () => {
		await sql`
			INSERT INTO _emdash_404_log (path, created_at) VALUES
				('/a', '2026-01-01T00:00:00Z'),
				('/a', '2026-01-02T00:00:00Z'),
				('/b', '2026-01-01T00:00:00Z')
		`.execute(db);

		await up(db);

		const rows = await sql<{ path: string; hits: number }>`
			SELECT path, hits FROM _emdash_404_log ORDER BY path
		`.execute(db);
		expect(rows.rows).toEqual([
			{ path: "/a", hits: 2 },
			{ path: "/b", hits: 1 },
		]);
	});

	// Regression: dedup was gated on `if (!hitsExists)`, so a retry after the
	// `hits` column already committed would skip dedup and crash on the unique
	// index. Gate dedup on the unique index instead.
	it("dedups on retry when a previous attempt added `hits` but never deduped", async () => {
		await sql`
			INSERT INTO _emdash_404_log (path, created_at) VALUES
				('/a', '2026-01-01T00:00:00Z'),
				('/a', '2026-01-02T00:00:00Z')
		`.execute(db);

		// Simulate a partial first run: `hits` and `last_seen_at` are already
		// present, but the unique index never got created because dedup
		// crashed (or the row count grew between attempts).
		await db.schema
			.alterTable("_emdash_404_log")
			.addColumn("hits", "integer", (col) => col.notNull().defaultTo(1))
			.execute();
		await db.schema.alterTable("_emdash_404_log").addColumn("last_seen_at", "text").execute();

		await expect(up(db)).resolves.not.toThrow();

		const rows = await sql<{ path: string }>`
			SELECT path FROM _emdash_404_log
		`.execute(db);
		expect(rows.rows).toEqual([{ path: "/a" }]);
	});
});

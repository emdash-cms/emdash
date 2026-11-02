import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { up } from "../../../../src/database/migrations/035_bounded_404_log.js";
import {
	createForDialect,
	describeEachDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../../utils/test-db.js";

async function createPre035Log(db: Kysely<unknown>): Promise<void> {
	await db.schema
		.createTable("_emdash_404_log")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("path", "text", (col) => col.notNull())
		.addColumn("referrer", "text")
		.addColumn("user_agent", "text")
		.addColumn("ip", "text")
		.addColumn("created_at", "text")
		.execute();
	await db.schema.createIndex("idx_404_log_path").on("_emdash_404_log").column("path").execute();
}

describeEachDialect("035_bounded_404_log migration", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<unknown>;

	beforeEach(async () => {
		ctx = await createForDialect(dialect);
		db = ctx.db as unknown as Kysely<unknown>;
		await createPre035Log(db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("keeps the freshest row per path with the rolled-up hit count", async () => {
		await sql`
			INSERT INTO _emdash_404_log (id, path, created_at) VALUES
				('a1', '/a', '2024-01-01T00:00:00Z'),
				('a2', '/a', '2024-01-03T00:00:00Z'),
				('a3', '/a', '2024-01-02T00:00:00Z'),
				('b1', '/b', '2024-01-05T00:00:00Z')
		`.execute(db);

		await up(db);

		const rows = await sql<{ id: string; path: string; hits: number; last_seen_at: string }>`
			SELECT id, path, hits, last_seen_at FROM _emdash_404_log ORDER BY path
		`.execute(db);
		expect(rows.rows.map((row) => ({ ...row, hits: Number(row.hits) }))).toEqual([
			{ id: "a2", path: "/a", hits: 3, last_seen_at: "2024-01-03T00:00:00Z" },
			{ id: "b1", path: "/b", hits: 1, last_seen_at: "2024-01-05T00:00:00Z" },
		]);
	});

	it("finishes deduplicating when a previous run stopped after adding the columns", async () => {
		await sql`ALTER TABLE _emdash_404_log ADD COLUMN hits integer NOT NULL DEFAULT 1`.execute(db);
		await sql`
			INSERT INTO _emdash_404_log (id, path, created_at) VALUES
				('a1', '/a', '2024-01-01T00:00:00Z'),
				('a2', '/a', '2024-01-02T00:00:00Z')
		`.execute(db);

		await up(db);

		const rows = await sql<{ id: string; hits: number }>`
			SELECT id, hits FROM _emdash_404_log
		`.execute(db);
		expect(rows.rows.map((row) => ({ ...row, hits: Number(row.hits) }))).toEqual([
			{ id: "a2", hits: 2 },
		]);
	});

	it("deduplicates a large log without timing out", { timeout: 15_000 }, async () => {
		await sql`
			INSERT INTO _emdash_404_log (id, path, created_at)
			WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 80000)
			SELECT 'r' || i, '/p' || (i % 8000), '2024-01-01T00:00:00Z' FROM n
		`.execute(db);

		await db.connection().execute(async (conn) => {
			if (dialect === "postgres") await sql`SET statement_timeout = 5000`.execute(conn);
			await up(conn);
		});

		const summary = await sql<{ rows: number | string; min_hits: number; max_hits: number }>`
			SELECT COUNT(*) AS rows, MIN(hits) AS min_hits, MAX(hits) AS max_hits
			FROM _emdash_404_log
		`.execute(db);
		expect(summary.rows[0]).toMatchObject({ min_hits: 10, max_hits: 10 });
		expect(Number(summary.rows[0]?.rows)).toBe(8000);
		const keeper = await sql<{ id: string }>`
			SELECT id FROM _emdash_404_log WHERE path = '/p0'
		`.execute(db);
		expect(keeper.rows).toEqual([{ id: "r80000" }]);
	});
});

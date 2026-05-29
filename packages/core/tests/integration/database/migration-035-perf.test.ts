/**
 * Regression test for #1085.
 *
 * Migration 035_bounded_404_log performs a deduplication UPDATE whose SET
 * clause uses two correlated subqueries against a CTE. On Postgres the
 * planner cannot materialize the CTE for those correlated lookups so each
 * subquery rescans `ranked` end-to-end — the whole UPDATE is O(n²).
 *
 * On a production `_emdash_404_log` with ~223k rows this never completes
 * within a sane migration window and the pg client OOMs the node process
 * while buffering the never-resolving result.
 *
 * This test populates the table with a moderate number of rows (a few tens
 * of thousands, with heavy path duplication) and runs the migration's
 * `up()` against Postgres under a tight wall-clock timeout. On the broken
 * implementation the dedup UPDATE blows past the timeout; once the query
 * is rewritten as a linear pass (e.g. via a temp table) it finishes in
 * well under a second.
 */

import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { up as migration035Up } from "../../../src/database/migrations/035_bounded_404_log.js";
import {
	createTestPostgresDatabase,
	hasPgTestDatabase,
	teardownTestPostgresDatabase,
	type PgTestContext,
} from "../../utils/test-db.js";

// Postgres-only: SQLite's planner happens to handle the correlated-subquery
// pattern reasonably on these sizes. The wedge is specifically a pg planner
// pathology.
const describePg = hasPgTestDatabase ? describe : describe.skip;

describePg("migration 035 dedup performance (reproduces #1085)", () => {
	let ctx: PgTestContext;

	beforeEach(async () => {
		ctx = await createTestPostgresDatabase();

		// Re-create the pre-035 _emdash_404_log schema (matches migration 029).
		await sql`
			CREATE TABLE _emdash_404_log (
				id text PRIMARY KEY,
				path text NOT NULL,
				referrer text,
				user_agent text,
				ip text,
				created_at text DEFAULT (now()::text)
			)
		`.execute(ctx.db);
		await sql`CREATE INDEX idx_404_log_path ON _emdash_404_log (path)`.execute(ctx.db);
	});

	afterEach(async () => {
		await teardownTestPostgresDatabase(ctx);
	});

	it("reproduces #1085: dedup UPDATE wedges on tens of thousands of rows", async () => {
		// 20k rows with ~10 duplicates per path (2k distinct paths) is enough to
		// expose the O(n²) blowup. The broken query takes tens of seconds; the
		// fixed (linear) version finishes in well under a second.
		// At 20k rows / 2k paths the broken query already takes ~5s on CI; at
		// 40k rows it's ~20s. We pick numbers that comfortably exceed the
		// timeout when broken but finish in well under a second when fixed.
		const TOTAL_ROWS = 40_000;
		const DISTINCT_PATHS = 4_000;
		const TIMEOUT_MS = 10_000;

		// Bound the dedup query at the database level so the broken
		// implementation surfaces as a clean ERROR instead of leaving an
		// in-flight query that wedges the afterEach teardown.
		await sql`SET statement_timeout = ${sql.lit(TIMEOUT_MS)}`.execute(ctx.db);

		const baseMs = Date.parse("2024-01-01T00:00:00Z");
		const batchSize = 1_000;
		for (let start = 0; start < TOTAL_ROWS; start += batchSize) {
			const end = Math.min(start + batchSize, TOTAL_ROWS);
			const rows: Array<{
				id: string;
				path: string;
				referrer: null;
				user_agent: null;
				ip: null;
				created_at: string;
			}> = [];
			for (let i = start; i < end; i++) {
				rows.push({
					id: `row-${i.toString().padStart(8, "0")}`,
					path: `/p/${i % DISTINCT_PATHS}`,
					referrer: null,
					user_agent: null,
					ip: null,
					created_at: new Date(baseMs + i * 1000).toISOString(),
				});
			}
			await ctx.db
				.insertInto("_emdash_404_log" as never)
				.values(rows as never)
				.execute();
		}

		const started = Date.now();
		let error: unknown = null;
		try {
			await migration035Up(ctx.db);
		} catch (err) {
			error = err;
		}
		const elapsedMs = Date.now() - started;

		// eslint-disable-next-line no-console
		console.log(
			`[#1085] migration 035 over ${TOTAL_ROWS} rows / ${DISTINCT_PATHS} distinct paths: ` +
				`${error ? `failed after ${elapsedMs}ms — ${(error as Error).message}` : `finished in ${elapsedMs}ms`}`,
		);

		// On the broken implementation Postgres aborts the dedup UPDATE with
		// `canceling statement due to statement timeout`. Once the migration
		// is rewritten as a linear pass it completes in well under a second.
		expect(error).toBeNull();
		expect(elapsedMs).toBeLessThan(TIMEOUT_MS);

		// Sanity: after dedup, exactly one row per path remains and each
		// keeper's hits equals the original duplicate count for that path.
		const expectedPerPath = TOTAL_ROWS / DISTINCT_PATHS;
		const { rows } = await sql<{
			n: string | number;
			min_hits: string | number;
			max_hits: string | number;
		}>`
			SELECT
				COUNT(*) AS n,
				MIN(hits) AS min_hits,
				MAX(hits) AS max_hits
			FROM _emdash_404_log
		`.execute(ctx.db);
		const summary = rows[0];
		expect(summary).toBeDefined();
		expect(Number(summary!.n)).toBe(DISTINCT_PATHS);
		expect(Number(summary!.min_hits)).toBe(expectedPerPath);
		expect(Number(summary!.max_hits)).toBe(expectedPerPath);
	}, 60_000);
});

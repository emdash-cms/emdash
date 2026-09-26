/**
 * Headline contract: NO OVERSELL UNDER CONCURRENCY.
 *
 * Seed stock M, fire N > M concurrent guarded decrements
 * (`updateIf({ where: { stock: { gte: 1 } }, delta: { stock: { dec: 1 } } })`)
 * and assert exactly M succeed, N − M fail, and the final stock is 0.
 *
 * IMPORTANT — what each dialect proves:
 * - **better-sqlite3 [sqlite]** serializes all writes in-process (a single
 *   process-wide lock), so this run proves the SQL / single-statement-guard is
 *   CORRECT, but it does NOT prove the race — the decrements never actually
 *   overlap. The real concurrent-race assertion is Postgres.
 * - **Postgres** is a real concurrent backend: N connections race the same row
 *   simultaneously. Because the guard and the arithmetic live in ONE
 *   `UPDATE … WHERE stock >= 1 … RETURNING`, row-level locking serializes them
 *   and exactly M can observe `stock >= 1` — this is the true no-oversell proof.
 */

import type { Kysely } from "kysely";
import { it, expect, beforeEach, afterEach } from "vitest";

import { PluginStorageRepository } from "../../../src/database/repositories/plugin-storage.js";
import type { Database } from "../../../src/database/types.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

interface Item {
	stock: number;
}

describeEachDialect("Plugin storage no-oversell", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		db = ctx.db;
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it(
		dialect === "sqlite"
			? "exactly M of N guarded decrements apply (better-sqlite3 serializes writes in-process → proves SQL correctness, NOT the race)"
			: "exactly M of N guarded decrements apply under real concurrent connections (the true no-oversell race)",
		async () => {
			const repo = new PluginStorageRepository<Item>(db, "shop", "inventory", ["stock"]);
			const M = 5;
			const N = 20;
			// Seed with the existing unconditional upsert (single-threaded setup).
			await repo.put("widget", { stock: M });

			const results = await Promise.all(
				Array.from({ length: N }, () =>
					repo.updateIf("widget", {
						where: { stock: { gte: 1 } },
						delta: { stock: { dec: 1 } },
					}),
				),
			);

			const applied = results.filter((r) => r.applied).length;
			const rejected = results.filter((r) => !r.applied).length;

			expect(applied).toBe(M);
			expect(rejected).toBe(N - M);
			expect((await repo.get("widget"))?.stock).toBe(0);
		},
	);
});

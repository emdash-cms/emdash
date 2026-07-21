/**
 * Plugin storage `updateIf` — predicate-guarded atomic update.
 *
 * Runs on SQLite (always) and Postgres (when EMDASH_TEST_PG is set). The guard
 * reuses the same numeric-correct WhereClause translation as `query()`, so a
 * multi-digit numeric guard like `stock >= 10` must compare NUMERICALLY on
 * Postgres — `'9' >= '10'` is TRUE lexically but false numerically. The write
 * arithmetic runs entirely in-SQL (json_set / jsonb_set) so there is no
 * read-then-write. Rows are seeded with the existing unconditional `put`.
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

interface Product {
	sku: string;
	stock: number;
	tier: number;
	name: string;
}

describeEachDialect("Plugin storage updateIf", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		db = ctx.db;
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	function productsRepo(indexes: Array<string | string[]> = ["sku", "stock", "tier", "name"]) {
		return new PluginStorageRepository<Product>(db, "shop", "products", indexes);
	}

	// ── guard pass / fail / missing ─────────────────────────────────────────

	it("updateIf() guard passes → { applied: true, data } with the new value", async () => {
		const repo = productsRepo();
		await repo.put("p1", { sku: "A", stock: 10, tier: 1, name: "Alpha" });

		const result = await repo.updateIf("p1", {
			where: { stock: { gte: 1 } },
			delta: { stock: { dec: 1 } },
		});
		expect(result).toEqual({ applied: true, data: { sku: "A", stock: 9, tier: 1, name: "Alpha" } });
		expect((await repo.get("p1"))?.stock).toBe(9);
	});

	it("updateIf() guard fails → { applied: false } and the row is unchanged", async () => {
		const repo = productsRepo();
		await repo.put("p1", { sku: "A", stock: 0, tier: 1, name: "Alpha" });

		const result = await repo.updateIf("p1", {
			where: { stock: { gte: 1 } },
			delta: { stock: { dec: 1 } },
		});
		expect(result).toEqual({ applied: false });
		expect((await repo.get("p1"))?.stock).toBe(0);
	});

	it("updateIf() on a missing row → { applied: false } and never inserts", async () => {
		const repo = productsRepo();
		const result = await repo.updateIf("ghost", {
			where: { stock: { gte: 1 } },
			delta: { stock: { dec: 1 } },
		});
		expect(result).toEqual({ applied: false });
		expect(await repo.get("ghost")).toBeNull();
	});

	// ── delta arithmetic ────────────────────────────────────────────────────

	it("updateIf() integer inc then dec is exact and round-trips as an integer", async () => {
		const repo = productsRepo();
		await repo.put("p1", { sku: "A", stock: 5, tier: 1, name: "Alpha" });

		const inc = await repo.updateIf("p1", { where: { sku: "A" }, delta: { stock: { inc: 3 } } });
		expect(inc).toEqual({ applied: true, data: { sku: "A", stock: 8, tier: 1, name: "Alpha" } });

		const dec = await repo.updateIf("p1", { where: { sku: "A" }, delta: { stock: { dec: 2 } } });
		expect(dec).toEqual({ applied: true, data: { sku: "A", stock: 6, tier: 1, name: "Alpha" } });

		// Round-trips as a real integer (not 6.0 / "6") through the text-JSON column.
		const row = await db
			.selectFrom("_plugin_storage")
			.select("data")
			.where("id", "=", "p1")
			.executeTakeFirstOrThrow();
		expect(JSON.parse(row.data).stock).toBe(6);
		expect(Number.isInteger(JSON.parse(row.data).stock)).toBe(true);
	});

	it("updateIf() rejects a float delta with a TypeError and leaves the row unchanged", async () => {
		const repo = productsRepo();
		await repo.put("p1", { sku: "A", stock: 5, tier: 1, name: "Alpha" });

		await expect(
			repo.updateIf("p1", { where: { sku: "A" }, delta: { stock: { dec: 1.5 } } }),
		).rejects.toThrow(TypeError);
		expect((await repo.get("p1"))?.stock).toBe(5);
	});

	it("updateIf() delta on a missing/null field starts from COALESCE(0)", async () => {
		// `stock` absent on p-missing, JSON-null on p-null. Both must inc from 0.
		const repo = new PluginStorageRepository<Record<string, unknown>>(db, "shop", "counters", [
			"kind",
		]);
		await repo.put("p-missing", { kind: "a" });
		await repo.put("p-null", { kind: "b", hits: null });

		const r1 = await repo.updateIf("p-missing", {
			where: { kind: "a" },
			delta: { hits: { inc: 2 } },
		});
		expect(r1).toEqual({ applied: true, data: { kind: "a", hits: 2 } });

		const r2 = await repo.updateIf("p-null", {
			where: { kind: "b" },
			delta: { hits: { inc: 3 } },
		});
		expect((r2 as { applied: true; data: { hits: number } }).data.hits).toBe(3);
	});

	// ── set / mixed / validation ────────────────────────────────────────────

	it("updateIf() wholesale `set` merges fields, preserving the rest", async () => {
		const repo = productsRepo();
		await repo.put("p1", { sku: "A", stock: 5, tier: 1, name: "Alpha" });

		const result = await repo.updateIf("p1", {
			where: { sku: "A" },
			set: { name: "Renamed", tier: 3 },
		});
		expect(result).toEqual({
			applied: true,
			data: { sku: "A", stock: 5, tier: 3, name: "Renamed" },
		});
	});

	it("updateIf() applies `set` and `delta` together in one call", async () => {
		const repo = productsRepo();
		await repo.put("p1", { sku: "A", stock: 5, tier: 1, name: "Alpha" });

		const result = await repo.updateIf("p1", {
			where: { stock: { gte: 1 } },
			set: { name: "Sold" },
			delta: { stock: { dec: 1 } },
		});
		expect(result).toEqual({
			applied: true,
			data: { sku: "A", stock: 4, tier: 1, name: "Sold" },
		});
	});

	it("updateIf() rejects a field named in both `set` and `delta`", async () => {
		const repo = productsRepo();
		await repo.put("p1", { sku: "A", stock: 5, tier: 1, name: "Alpha" });
		await expect(
			repo.updateIf("p1", { where: { sku: "A" }, set: { stock: 1 }, delta: { stock: { dec: 1 } } }),
		).rejects.toThrow(/both/i);
	});

	it("updateIf() throws when neither `set` nor `delta` is provided", async () => {
		const repo = productsRepo();
		await repo.put("p1", { sku: "A", stock: 5, tier: 1, name: "Alpha" });
		await expect(repo.updateIf("p1", { where: { sku: "A" } })).rejects.toThrow(/set.*delta/i);
	});

	// ── guard operator coverage ─────────────────────────────────────────────

	it("updateIf() guard covers equality, multi-digit gte, in, startsWith, and a non-indexed field", async () => {
		// Repo declares NO indexes: updateIf must NOT require the guard field to
		// be indexed (unlike query()). Guarding on `stock` here proves that.
		const repo = productsRepo([]);
		await repo.put("p9", { sku: "A9", stock: 9, tier: 1, name: "Alpha" });
		await repo.put("p10", { sku: "B10", stock: 10, tier: 2, name: "Bravo" });

		// equality guard-pass
		expect((await repo.updateIf("p9", { where: { sku: "A9" }, set: { name: "Eq" } })).applied).toBe(
			true,
		);

		// RangeFilter gte with a MULTI-DIGIT threshold: numeric, not lexical.
		// stock 9 vs gte:10 → fails (9 is NOT >= 10, even though '9' >= '10' lexically).
		expect(
			(await repo.updateIf("p9", { where: { stock: { gte: 10 } }, set: { name: "No" } })).applied,
		).toBe(false);
		// stock 10 vs gte:10 → passes.
		expect(
			(await repo.updateIf("p10", { where: { stock: { gte: 10 } }, set: { name: "Yes" } })).applied,
		).toBe(true);

		// in filter
		expect(
			(await repo.updateIf("p9", { where: { tier: { in: [1, 5] } }, set: { name: "In" } })).applied,
		).toBe(true);

		// startsWith
		expect(
			(await repo.updateIf("p10", { where: { sku: { startsWith: "B" } }, set: { name: "Sw" } }))
				.applied,
		).toBe(true);
	});

	it("updateIf() with an empty `in: []` guard → { applied: false } and no SQL error", async () => {
		const repo = productsRepo([]);
		await repo.put("p1", { sku: "A", stock: 5, tier: 1, name: "Alpha" });
		const result = await repo.updateIf("p1", {
			where: { tier: { in: [] } },
			delta: { stock: { dec: 1 } },
		});
		expect(result).toEqual({ applied: false });
		expect((await repo.get("p1"))?.stock).toBe(5);
	});
});

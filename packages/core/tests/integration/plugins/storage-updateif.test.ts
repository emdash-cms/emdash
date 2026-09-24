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
import { StorageQueryError } from "../../../src/plugins/storage-query.js";
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

	it("updateIf() with an all-`undefined` delta (no set) throws and never writes", async () => {
		const repo = productsRepo();
		await repo.put("p1", { sku: "A", stock: 5, tier: 1, name: "Alpha" });
		await expect(
			repo.updateIf("p1", { where: { sku: "A" }, delta: { stock: undefined } }),
		).rejects.toThrow(/set.*delta/i);
		expect((await repo.get("p1"))?.stock).toBe(5);
	});

	it("updateIf() with an all-`undefined` guard throws instead of writing unguarded", async () => {
		// An empty predicate contributes no SQL. Dropped silently, it would leave
		// the UPDATE unguarded and drive stock past the bound the caller asked for.
		const repo = productsRepo();
		await repo.put("p1", { sku: "A", stock: 0, tier: 1, name: "Alpha" });
		await expect(
			repo.updateIf("p1", {
				where: { stock: { gte: undefined } },
				delta: { stock: { dec: 1 } },
			}),
		).rejects.toThrow(StorageQueryError);
		expect((await repo.get("p1"))?.stock).toBe(0);
	});

	it("updateIf() with an all-`undefined` set (no delta) throws and never writes", async () => {
		const repo = productsRepo();
		await repo.put("p1", { sku: "A", stock: 5, tier: 1, name: "Alpha" });
		await expect(
			repo.updateIf("p1", { where: { sku: "A" }, set: { name: undefined } }),
		).rejects.toThrow(/set.*delta/i);
		expect((await repo.get("p1"))?.name).toBe("Alpha");
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

	it.each([
		{ operator: "in", filter: { in: ["Alpha"], gte: "Z" } },
		{ operator: "startsWith", filter: { startsWith: "A", gte: "Z" } },
	])("uses $operator before range bounds as query() does", async ({ filter }) => {
		const repo = productsRepo();
		await repo.put("p1", { sku: "A", stock: 5, tier: 1, name: "Alpha" });
		const where = { name: filter };
		expect((await repo.query({ where })).items).toHaveLength(1);
		expect(await repo.updateIf("p1", { where, set: { name: "changed" } })).toEqual({
			applied: true,
			data: { sku: "A", stock: 5, tier: 1, name: "changed" },
		});
	});

	it("enforces the defined range bound when another bound is undefined", async () => {
		const repo = productsRepo();
		await repo.put("p1", { sku: "A", stock: 5, tier: 1, name: "Alpha" });
		expect(
			await repo.updateIf("p1", {
				where: { stock: { gte: 6, lte: undefined } },
				set: { name: "changed" },
			}),
		).toEqual({ applied: false });
		expect((await repo.get("p1"))?.name).toBe("Alpha");
		expect(
			await repo.updateIf("p1", {
				where: { stock: { gte: 5, lte: undefined } },
				set: { name: "changed" },
			}),
		).toEqual({
			applied: true,
			data: { sku: "A", stock: 5, tier: 1, name: "changed" },
		});
	});

	async function storedProduct(id = "p1") {
		return db
			.selectFrom("_plugin_storage")
			.selectAll()
			.where("plugin_id", "=", "shop")
			.where("collection", "=", "products")
			.where("id", "=", id)
			.executeTakeFirstOrThrow();
	}

	it.each([
		{ name: "missing guard", args: { set: { name: "changed" } } },
		{ name: "array guard", args: { where: [], set: { name: "changed" } } },
		{
			name: "undefined range bound",
			args: { where: { stock: { gte: undefined } }, set: { name: "changed" } },
		},
		{
			name: "empty range",
			args: { where: { stock: {} }, set: { name: "changed" } },
		},
		{
			name: "non-finite guard",
			args: { where: { stock: { gte: -Infinity } }, set: { name: "changed" } },
		},
		{ name: "array set", args: { where: {}, set: ["changed"] } },
		{ name: "nonserializable set", args: { where: {}, set: { name: () => "changed" } } },
		{ name: "unknown argument", args: { where: {}, set: { name: "changed" }, increment: 1 } },
		{
			name: "ambiguous delta",
			args: { where: {}, delta: { stock: { inc: 1, dec: "invalid" } } },
		},
		{
			name: "unsafe delta",
			args: { where: {}, delta: { stock: { inc: Number.MAX_SAFE_INTEGER + 1 } } },
		},
		{
			name: "non-object guard",
			args: { where: new Date(0), set: { name: "changed" } },
		},
	])("rejects $name without modifying the stored row", async ({ args }) => {
		const repo = productsRepo();
		await repo.put("p1", { sku: "A", stock: 5, tier: 1, name: "Alpha" });
		const before = await storedProduct();
		await expect(repo.updateIf("p1", args)).rejects.toThrow();
		expect(await storedProduct()).toEqual(before);
	});

	it("rejects a sparse in filter with a TypeError without modifying the stored row", async () => {
		const repo = productsRepo();
		await repo.put("p1", { sku: "A", stock: 5, tier: 1, name: "Alpha" });
		const before = await storedProduct();
		const values = [5];
		values.length = 2;
		await expect(
			repo.updateIf("p1", { where: { stock: { in: values } }, set: { name: "changed" } }),
		).rejects.toThrow(TypeError);
		expect(await storedProduct()).toEqual(before);
	});

	it.each(["4", true, [], {}, 1.5, Number.MAX_SAFE_INTEGER + 1].map((stock) => ({ stock })))(
		"does not overwrite an invalid stored counter: $stock",
		async ({ stock }) => {
			const repo = new PluginStorageRepository(db, "shop", "products", []);
			await repo.put("p1", { stock });
			const before = await storedProduct();
			expect(await repo.updateIf("p1", { where: {}, delta: { stock: { inc: 1 } } })).toEqual({
				applied: false,
			});
			expect(await storedProduct()).toEqual(before);
		},
	);

	it.each([null, 1, "value", []].map((value) => ({ value })))(
		"does not modify a non-object document: $value",
		async ({ value }) => {
			const repo = new PluginStorageRepository(db, "shop", "products", []);
			await repo.put("p1", value);
			const before = await storedProduct();
			expect(await repo.updateIf("p1", { where: {}, set: { name: "changed" } })).toEqual({
				applied: false,
			});
			expect(await storedProduct()).toEqual(before);
		},
	);

	it.each([Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER])(
		"rejects arithmetic beyond the safe boundary %s without modifying the row",
		async (stock) => {
			const repo = new PluginStorageRepository(db, "shop", "products", []);
			await repo.put("p1", { stock });
			const before = await storedProduct();
			expect(
				await repo.updateIf("p1", { where: {}, delta: { stock: { inc: Math.sign(stock) } } }),
			).toEqual({ applied: false });
			expect(await storedProduct()).toEqual(before);
		},
	);

	it.each([Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER])(
		"preserves the exact safe-integer boundary %s",
		async (stock) => {
			const repo = new PluginStorageRepository(db, "shop", "products", []);
			await repo.put("p1", { stock: stock - Math.sign(stock) });
			expect(
				await repo.updateIf("p1", { where: {}, delta: { stock: { inc: Math.sign(stock) } } }),
			).toEqual({ applied: true, data: { stock } });
			expect(await repo.get("p1")).toEqual({ stock });
		},
	);

	it("preserves negative deltas and ignores undefined entries beside a defined write", async () => {
		const repo = productsRepo();
		await repo.put("p1", { sku: "A", stock: 5, tier: 1, name: "Alpha" });
		expect(
			await repo.updateIf("p1", {
				where: {},
				set: { name: undefined, stock: undefined },
				delta: { stock: { inc: -2 }, tier: undefined },
			}),
		).toEqual({ applied: true, data: { sku: "A", stock: 3, tier: 1, name: "Alpha" } });
	});

	it("ignores undefined entries without validating their unused field paths", async () => {
		const repo = productsRepo();
		await repo.put("p1", { sku: "A", stock: 5, tier: 1, name: "Alpha" });
		expect(
			await repo.updateIf("p1", {
				where: {},
				set: { "unused.path": undefined, name: "changed" },
				delta: { "another.path": undefined },
			}),
		).toEqual({ applied: true, data: { sku: "A", stock: 5, tier: 1, name: "changed" } });
	});

	it.each([1, { toString: () => "1" }])("rejects a non-string ID: %s", async (id) => {
		const repo = productsRepo();
		await repo.put("1", { sku: "A", stock: 5, tier: 1, name: "Alpha" });
		const before = await storedProduct("1");
		await expect(
			repo.updateIf(id as unknown as string, { where: {}, set: { stock: 0 } }),
		).rejects.toThrow(TypeError);
		expect(await storedProduct("1")).toEqual(before);
	});
});

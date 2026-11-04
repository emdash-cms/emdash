/**
 * Plugin storage: numeric comparisons/ordering are lexical on Postgres.
 *
 * `_plugin_storage.data` is a plain `text` column, and plugin storage was only
 * ever exercised on SQLite. #1898 (fix for #920) added the `(data)::jsonb->>'…'`
 * cast, so the JSON accessor no longer raises "operator does not exist:
 * text ->> unknown" and boolean/equality filters work. But `->>` still yields
 * **text**, and the query/count/order paths compare that text directly — so on
 * Postgres a numeric guard compares lexically:
 *
 *   '9' >= '10'   →  TRUE   (lexical)   but  9 >= 10  →  false (numeric)
 *
 * The consequences are a silent over-count / oversell and mis-ordering:
 *
 *   (a) a RangeFilter `{ stock: { gte: 10 } }` over 9 / 10 / 100 returns 9 too
 *   (b) count() of the same guard returns 3 instead of 2
 *   (c) createStorageIndexes' UNIQUE expression index — already fixed by #1898,
 *       kept here as a passing guard that the `->>` parse path stays healthy
 *   (d) orderBy on a numeric field returns [10, 100, 9] instead of [9, 10, 100]
 *
 * These run on SQLite (always) and Postgres (when EMDASH_TEST_PG is set).
 * SQLite's json_extract returns a typed value, so it is green throughout — which
 * is exactly why the bug went unnoticed. The Postgres dialect FAILS on (a),(b),
 * (d) on current main. The fix is a type-guarded numeric cast on the extracted
 * value for numeric comparisons/order (mirroring how json_extract is already
 * typed on SQLite).
 */

import type { Kysely } from "kysely";
import { it, expect, beforeEach, afterEach } from "vitest";

import { PluginStorageRepository } from "../../../src/database/repositories/plugin-storage.js";
import type { Database } from "../../../src/database/types.js";
import { createStorageIndexes } from "../../../src/plugins/storage-indexes.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

interface Product {
	sku: string;
	stock: number;
}

describeEachDialect("Plugin storage numeric comparison on Postgres", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		db = ctx.db;
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	function productsRepo(): PluginStorageRepository<Product> {
		// `stock` is declared indexed so it may be used in orderBy.
		return new PluginStorageRepository<Product>(db, "shop", "products", ["sku", "stock"]);
	}

	/** Stock values chosen so lexical and numeric ordering disagree: '9' > '10'. */
	async function seedProducts(): Promise<PluginStorageRepository<Product>> {
		const repo = productsRepo();
		await repo.putMany([
			{ id: "p9", data: { sku: "A9", stock: 9 } },
			{ id: "p10", data: { sku: "B10", stock: 10 } },
			{ id: "p100", data: { sku: "C100", stock: 100 } },
		]);
		return repo;
	}

	// (a) The load-bearing case: a lexical `>=` includes stock 9 in a `>= 10`
	// filter — a silent over-count / oversell.
	it("numeric RangeFilter { gte: 10 } returns exactly {10, 100}, never 9", async () => {
		const repo = await seedProducts();
		const result = await repo.query({ where: { stock: { gte: 10 } } });
		expect(result.items.map((i) => i.id).toSorted()).toEqual(["p10", "p100"]);
		expect(result.items.map((i) => i.data.stock).toSorted((a, b) => a - b)).toEqual([10, 100]);
	});

	// (b) Same lexical bug via the aggregate path.
	it("count({ stock: { gte: 10 } }) is numerically correct (2, not 3)", async () => {
		const repo = await seedProducts();
		expect(await repo.count({ stock: { gte: 10 } })).toBe(2);
	});

	// (c) Already fixed by #1898 (the ::jsonb cast). Kept as a guard that the
	// `->>` expression-index path parses and enforces uniqueness on Postgres.
	it("creates and enforces a UNIQUE expression index (regression guard for #1898)", async () => {
		const result = await createStorageIndexes(db, "shop", "products", [], {
			uniqueIndexes: ["sku"],
		});
		expect(result.errors).toEqual([]);
		expect(result.created).toContain("uidx_plugin_shop_products_sku");

		const repo = productsRepo();
		await repo.put("first", { sku: "DUP", stock: 1 });
		await expect(repo.put("second", { sku: "DUP", stock: 2 })).rejects.toThrow();
	});

	// (d) Lexical ORDER BY on the text extraction.
	it("orderBy { stock: 'asc' } sorts numerically [9, 10, 100], not lexically [10, 100, 9]", async () => {
		const repo = await seedProducts();
		const asc = await repo.query({ orderBy: { stock: "asc" } });
		expect(asc.items.map((i) => i.data.stock)).toEqual([9, 10, 100]);
		expect(asc.items.map((i) => i.id)).toEqual(["p9", "p10", "p100"]);

		const desc = await repo.query({ orderBy: { stock: "desc" } });
		expect(desc.items.map((i) => i.data.stock)).toEqual([100, 10, 9]);
	});
});

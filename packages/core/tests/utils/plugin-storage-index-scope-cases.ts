import type { Kysely } from "kysely";
import { sql } from "kysely";
import { expect, it } from "vitest";

import { isPostgres, jsonExtractExpr } from "../../src/database/dialect-helpers.js";
import type { Database } from "../../src/database/types.js";
import {
	createStorageIndexes,
	generateIndexName,
	removeOrphanedIndexes,
	syncStorageIndexes,
} from "../../src/plugins/storage-indexes.js";

export function registerPluginStorageIndexScopeCases(
	getDb: () => Kysely<Database>,
	options: { sqlite?: boolean } = {},
): void {
	const insert = async (pluginId: string, collection: string, id: string, data: unknown) => {
		await getDb()
			.insertInto("_plugin_storage")
			.values({ plugin_id: pluginId, collection, id, data: JSON.stringify(data) })
			.execute();
	};

	it("scopes case-distinct collections independently and keeps sync idempotent", async () => {
		const db = getDb();
		const collections = ["Items", "items"];
		for (const collection of collections) {
			const result = await syncStorageIndexes(db, "shop", collection, [], {
				uniqueIndexes: ["sku"],
			});
			expect(result.errors).toHaveLength(0);
			await insert("shop", collection, "owner", { sku: "ABC" });
			await expect(insert("shop", collection, "duplicate", { sku: "ABC" })).rejects.toThrow();
			await expect(insert("stock", collection, "one", { sku: "ABC" })).resolves.toBeUndefined();
			await expect(insert("stock", collection, "two", { sku: "ABC" })).resolves.toBeUndefined();
			const repeat = await syncStorageIndexes(db, "shop", collection, [], {
				uniqueIndexes: ["sku"],
			});
			expect(repeat.errors).toEqual([]);
			expect(repeat.removed).toEqual([]);
		}

		const expected = collections.map((collection) =>
			generateIndexName("shop", collection, ["sku"], { unique: true }),
		);
		expect(new Set(expected.map((name) => name.toLowerCase())).size).toBe(2);
		const indexes = isPostgres(db)
			? await sql<{ name: string }>`
					SELECT indexname AS name FROM pg_indexes
					WHERE schemaname = current_schema() AND tablename = '_plugin_storage'
				`.execute(db)
			: await sql<{ name: string }>`
					SELECT name FROM sqlite_master
					WHERE type = 'index' AND tbl_name = '_plugin_storage'
				`.execute(db);
		const physical = indexes.rows.map((row) => row.name);
		expect(physical.map((name) => name.toLowerCase())).toEqual(
			expect.arrayContaining(expected.map((name) => name.toLowerCase())),
		);
	});

	it("keeps case-distinct unique fields independently enforceable", async () => {
		const db = getDb();
		const result = await syncStorageIndexes(db, "shop", "items", [], {
			uniqueIndexes: ["sku", "SKU"],
		});
		expect(result.errors).toHaveLength(0);
		await insert("shop", "items", "owner", { sku: "lower", SKU: "upper" });
		await expect(
			insert("shop", "items", "duplicate-lower", { sku: "lower", SKU: "other" }),
		).rejects.toThrow();
		await expect(
			insert("shop", "items", "duplicate-upper", { sku: "other", SKU: "upper" }),
		).rejects.toThrow();
		const expected = ["sku", "SKU"].map((field) =>
			generateIndexName("shop", "items", [field], { unique: true }),
		);
		expect(new Set(expected.map((name) => name.toLowerCase())).size).toBe(2);
	});

	it("distinguishes underscore-separated scope and field tuples", async () => {
		const db = getDb();
		for (const [plugin, collection] of [
			["shop_items", "variants"],
			["shop", "items_variants"],
		]) {
			const result = await syncStorageIndexes(db, plugin, collection, [], {
				uniqueIndexes: ["sku"],
			});
			expect(result.errors).toEqual([]);
			await insert(plugin, collection, "owner", { sku: "ABC" });
			await expect(insert(plugin, collection, "duplicate", { sku: "ABC" })).rejects.toThrow();
		}
		const result = await syncStorageIndexes(db, "shop", "keys", [], {
			uniqueIndexes: [["region", "code"], "region_code"],
		});
		expect(result.errors).toEqual([]);
		await insert("shop", "keys", "owner", { region: "us", code: "A", region_code: "B" });
		await expect(
			insert("shop", "keys", "compound-duplicate", { region: "us", code: "A", region_code: "C" }),
		).rejects.toThrow();
		await expect(
			insert("shop", "keys", "field-duplicate", { region: "ca", code: "C", region_code: "B" }),
		).rejects.toThrow();
	});

	it("scopes long plugin unique indexes independently across fresh collections", async () => {
		const db = getDb();
		const plugin = `shop-${"x".repeat(65)}`;
		for (const collection of ["items", "orders"]) {
			const result = await syncStorageIndexes(db, plugin, collection, [], {
				uniqueIndexes: ["sku"],
			});
			expect(result.errors).toHaveLength(0);
			await insert(plugin, collection, "owner", { sku: "A" });
			await expect(insert(plugin, collection, "duplicate", { sku: "A" })).rejects.toThrow();
		}
		await expect(insert(plugin, "items", "other", { sku: "B" })).resolves.toBeUndefined();
		await expect(insert(plugin, "orders", "other", { sku: "B" })).resolves.toBeUndefined();
		const names = ["items", "orders"].map((collection) =>
			generateIndexName(plugin, collection, ["sku"], { unique: true }),
		);
		expect(new Set(names).size).toBe(2);
		expect(names.every((name) => name.length <= 63)).toBe(true);
	});

	it("scopes single, camelCase, and composite unique indexes to their owner", async () => {
		const db = getDb();
		const scopeResult = await syncStorageIndexes(
			db,
			"shop",
			"variants",
			["sku", "orderNumber", ["region", "code"]],
			{ uniqueIndexes: ["sku", "orderNumber", ["region", "code"]] },
		);
		expect(scopeResult.errors).toHaveLength(0);

		await expect(
			insert("stock", "movements", "m1", { sku: "A", orderNumber: "O", region: "r", code: "c" }),
		).resolves.toBeUndefined();
		await expect(
			insert("stock", "movements", "m2", { sku: "A", orderNumber: "O", region: "r", code: "c" }),
		).resolves.toBeUndefined();
		await expect(
			insert("shop", "other", "o1", { sku: "A", orderNumber: "O", region: "r", code: "c" }),
		).resolves.toBeUndefined();
		await expect(
			insert("shop", "other", "o2", { sku: "A", orderNumber: "O", region: "r", code: "c" }),
		).resolves.toBeUndefined();
		await expect(
			insert("other", "variants", "v1", { sku: "A", orderNumber: "O", region: "r", code: "c" }),
		).resolves.toBeUndefined();
		await expect(
			insert("other", "variants", "v2", { sku: "A", orderNumber: "O", region: "r", code: "c" }),
		).resolves.toBeUndefined();
		await expect(
			insert("shop", "variants", "v1", { sku: "A", orderNumber: "O", region: "r", code: "c" }),
		).resolves.toBeUndefined();

		await expect(
			insert("shop", "variants", "v2", { sku: "A", orderNumber: "O2", region: "r", code: "c2" }),
		).rejects.toThrow();
		await expect(
			insert("shop", "variants", "v3", { sku: "A3", orderNumber: "O", region: "r", code: "c3" }),
		).rejects.toThrow();
		await expect(
			insert("shop", "variants", "v4", { sku: "A4", orderNumber: "O4", region: "r", code: "c" }),
		).rejects.toThrow();
	});

	it("allows missing and null indexed values and rejects an update into the owner duplicate", async () => {
		const db = getDb();
		const createResult = await createStorageIndexes(db, "shop", "items", ["sku"], {
			uniqueIndexes: ["sku"],
		});
		expect(createResult.errors).toHaveLength(0);
		await insert("shop", "items", "missing", {});
		await insert("shop", "items", "null", { sku: null });
		await insert("shop", "items", "one", { sku: "ONE" });
		await insert("shop", "items", "two", { sku: "TWO" });

		await expect(
			db
				.updateTable("_plugin_storage")
				.set({ data: JSON.stringify({ sku: "ONE" }) })
				.where("id", "=", "two")
				.execute(),
		).rejects.toThrow();
	});

	it("permits duplicate values that existed in other scopes before declaration", async () => {
		const db = getDb();
		await insert("other", "items", "one", { sku: "OLD" });
		await insert("other", "items", "two", { sku: "OLD" });
		await insert("shop", "other", "one", { sku: "OLD" });
		const createResult = await createStorageIndexes(db, "shop", "items", ["sku"], {
			uniqueIndexes: ["sku"],
		});
		expect(createResult.errors).toHaveLength(0);
		await insert("other", "items", "three", { sku: "OLD" });
		await insert("shop", "other", "two", { sku: "OLD" });
		await insert("shop", "items", "one", { sku: "OLD" });
		await expect(insert("shop", "items", "two", { sku: "OLD" })).rejects.toThrow();
	});

	it("replaces a stale colliding regular index with the declared field", async () => {
		const db = getDb();
		const plugin = `shop-${"x".repeat(37)}`;
		const collection = "items";
		const expectedName = generateIndexName(plugin, collection, ["sku"]);
		const legacyName = `idx_plugin_${plugin}_${collection}_skuExtra`;
		const expression = jsonExtractExpr(db, "data", "skuExtra");
		const indexedExpression = isPostgres(db) ? `(${expression})` : expression;
		await sql`CREATE INDEX IF NOT EXISTS ${sql.ref(legacyName)}
			ON _plugin_storage(plugin_id, collection, ${sql.raw(indexedExpression)})`.execute(db);
		await db
			.insertInto("_plugin_indexes")
			.values({
				plugin_id: plugin,
				collection,
				index_name: legacyName,
				fields: JSON.stringify(["skuExtra"]),
			})
			.execute();

		const result = await syncStorageIndexes(db, plugin, collection, ["sku"]);
		expect(result.errors).toEqual([]);
		const definition = isPostgres(db)
			? await sql<{ name: string; definition: string }>`
					SELECT indexname AS name, indexdef AS definition
					FROM pg_indexes
					WHERE schemaname = current_schema()
						AND tablename = '_plugin_storage'
				`.execute(db)
			: await sql<{ name: string; definition: string }>`
					SELECT name, sql AS definition
					FROM sqlite_master
					WHERE type = 'index' AND tbl_name = '_plugin_storage'
				`.execute(db);
		const physical = definition.rows.find((row) => row.name === expectedName);
		expect(physical).toBeDefined();
		expect(physical!.definition).toContain("sku");
		expect(physical!.definition).not.toContain("skuExtra");
	});

	it("keeps regular lookup indexes alongside unique indexes and uses them for bound lookups", async () => {
		const db = getDb();
		const syncResult = await syncStorageIndexes(db, "shop", "items", [], {
			uniqueIndexes: ["sku"],
		});
		expect(syncResult.errors).toHaveLength(0);
		if (options.sqlite) {
			const indexes = await sql<{ name: string }>`
				SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_plugin_shop_items_sku%'
			`.execute(db);
			expect(indexes.rows.length).toBeGreaterThan(0);
			const plan = await sql<{ detail: string }>`
				EXPLAIN QUERY PLAN SELECT * FROM _plugin_storage
				WHERE plugin_id = ${"shop"} AND collection = ${"items"}
				AND json_extract(data, '$.sku') = ${"A"}
				ORDER BY json_extract(data, '$.sku')
			`.execute(db);
			expect(plan.rows.some((row) => row.detail.includes("idx_plugin_shop_items_sku"))).toBe(true);
			expect(plan.rows.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false);
		}
	});

	it("is idempotent, retains overlapping indexes, and removes only no-longer-declared indexes", async () => {
		const db = getDb();
		const initial = await syncStorageIndexes(db, "shop", "items", [], { uniqueIndexes: ["sku"] });
		expect(initial.errors).toHaveLength(0);
		const overlapping = await syncStorageIndexes(db, "shop", "items", ["sku"], {
			uniqueIndexes: ["sku"],
		});
		expect(overlapping.errors).toHaveLength(0);
		expect(overlapping.removed).toHaveLength(0);
		const again = await syncStorageIndexes(db, "shop", "items", ["sku"], {
			uniqueIndexes: ["sku"],
		});
		expect(again.errors).toHaveLength(0);
		expect(again.removed).toHaveLength(0);
		const regular = generateIndexName("shop", "items", ["sku"]);
		const unique = generateIndexName("shop", "items", ["sku"], { unique: true });
		const rows = await db
			.selectFrom("_plugin_indexes")
			.select("index_name")
			.where("plugin_id", "=", "shop")
			.execute();
		expect(rows.map((row) => row.index_name)).toEqual(expect.arrayContaining([regular, unique]));

		await removeOrphanedIndexes(db, "shop", "items", ["sku"]);
		const remaining = await db
			.selectFrom("_plugin_indexes")
			.select("index_name")
			.where("plugin_id", "=", "shop")
			.execute();
		expect(remaining.map((row) => row.index_name)).toContain(regular);
		expect(remaining.map((row) => row.index_name)).not.toContain(unique);
		await insert("shop", "items", "one", { sku: "DUP" });
		await insert("shop", "items", "two", { sku: "DUP" });
	});
}

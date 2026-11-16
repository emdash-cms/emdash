import { type Kysely, type KyselyPlugin, sql } from "kysely";
import { expect, it } from "vitest";

import { isPostgres, jsonExtractExpr } from "../../src/database/dialect-helpers.js";
import { up } from "../../src/database/migrations/095_plugin_storage_unique_scope.js";
import type { Database } from "../../src/database/types.js";
import { generateIndexName, syncStorageIndexes } from "../../src/plugins/storage-indexes.js";

const UNIQUE_NAME = "uidx_plugin_shop_product-items_sku";
const LOOKUP_NAME = "idx_plugin_shop_product-items_sku";
const TEMP_NAME = "uidx_m095_";

type IndexCase = { plugin: string; collection: string; name: string; fields: string[] };

function oldExpression(db: Kysely<unknown>, fields: string[]): string {
	return fields
		.map((field) => {
			const expression = jsonExtractExpr(db, "data", field);
			return isPostgres(db) ? `(${expression})` : expression;
		})
		.join(", ");
}

async function seedLegacyIndex(db: Kysely<Database>, entry: IndexCase): Promise<void> {
	const expression = oldExpression(db, entry.fields);
	await sql`
		CREATE UNIQUE INDEX IF NOT EXISTS ${sql.ref(entry.name)}
		ON _plugin_storage(plugin_id, collection, ${sql.raw(expression)})
	`.execute(db);
	await db
		.insertInto("_plugin_indexes")
		.values({
			plugin_id: entry.plugin,
			collection: entry.collection,
			index_name: entry.name,
			fields: JSON.stringify(entry.fields),
		})
		.execute();
}

async function put(
	db: Kysely<Database>,
	plugin: string,
	collection: string,
	id: string,
	data: unknown,
) {
	await db
		.insertInto("_plugin_storage")
		.values({ plugin_id: plugin, collection, id, data: JSON.stringify(data) })
		.execute();
}

async function indexNames(db: Kysely<Database>): Promise<string[]> {
	const result = isPostgres(db)
		? await sql<{
				name: string;
			}>`SELECT indexname AS name FROM pg_indexes WHERE tablename = '_plugin_storage'`.execute(db)
		: await sql<{
				name: string;
			}>`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = '_plugin_storage'`.execute(
				db,
			);
	return result.rows.map((row) => row.name);
}

function failAfter(statement: number): KyselyPlugin {
	let completed = 0;
	return {
		transformQuery: ({ node }) => node,
		transformResult: ({ result }) => {
			if (++completed === statement) throw new Error("lost migration response");
			return Promise.resolve(result);
		},
	};
}

let scopeCheck = 0;

async function assertScope(db: Kysely<Database>): Promise<void> {
	const stockId = `m${++scopeCheck}`;
	await expect(put(db, "stock", "movements", stockId, { sku: "ABC" })).resolves.toBeUndefined();
	await expect(put(db, "shop", "product-items", "duplicate", { sku: "ABC" })).rejects.toThrow();
	await expect(
		db
			.updateTable("_plugin_storage")
			.set({ data: JSON.stringify({ sku: "ABC" }) })
			.where("plugin_id", "=", "shop")
			.where("collection", "=", "product-items")
			.where("id", "=", "other")
			.execute(),
	).rejects.toThrow();
}

export function registerPluginStorageIndexMigrationCases(getDb: () => Kysely<Database>): void {
	it("migrates case-distinct collection and field names without losing either constraint", async () => {
		const db = getDb();
		const entries: IndexCase[] = [
			["Items", "sku"],
			["Items", "SKU"],
			["items", "sku"],
			["items", "SKU"],
		].map(([collection, field]) => ({
			plugin: "shop",
			collection,
			name: `uidx_plugin_shop_${collection}_${field}`,
			fields: [field],
		}));
		for (const collection of ["Items", "items"]) {
			await put(db, "shop", collection, "ownerABC", { sku: "ABC", SKU: "ABC" });
			for (const entry of entries.filter((candidate) => candidate.collection === collection)) {
				await seedLegacyIndex(db, entry);
			}
		}

		await up(db);
		await up(db);
		for (const collection of ["Items", "items"]) {
			await expect(
				put(db, "shop", collection, "duplicate-sku", { sku: "ABC", SKU: "other" }),
			).rejects.toThrow();
			await expect(
				put(db, "shop", collection, "duplicate-SKU", { sku: "other", SKU: "ABC" }),
			).rejects.toThrow();
			await expect(
				put(db, "stock", collection, "one", { sku: "ABC", SKU: "ABC" }),
			).resolves.toBeUndefined();
		}
		for (const entry of entries) {
			const tracked = await db
				.selectFrom("_plugin_indexes")
				.select("index_name")
				.where("plugin_id", "=", entry.plugin)
				.where("collection", "=", entry.collection)
				.where(
					"index_name",
					"=",
					generateIndexName(entry.plugin, entry.collection, entry.fields, { unique: true }),
				)
				.execute();
			expect(tracked).toHaveLength(1);
		}
		const names = entries.map((entry) =>
			generateIndexName(entry.plugin, entry.collection, entry.fields, { unique: true }),
		);
		expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(4);
		expect((await indexNames(db)).map((name) => name.toLowerCase())).toEqual(
			expect.arrayContaining(names.map((name) => name.toLowerCase())),
		);
	});

	it("converts legacy unique indexes to scoped indexes and preserves lookup tracking", async () => {
		const db = getDb();
		const owner: IndexCase = {
			plugin: "shop",
			collection: "product-items",
			name: UNIQUE_NAME,
			fields: ["sku"],
		};
		await put(db, "shop", "product-items", "owner", { sku: "ABC" });
		await put(db, "shop", "product-items", "other", { sku: "OTHER" });
		await seedLegacyIndex(db, owner);
		await put(db, "stock", "movements", "legacy-first", { sku: "ABC" });
		await expect(put(db, "stock", "movements", "legacy-second", { sku: "ABC" })).rejects.toThrow();

		await up(db);
		await assertScope(db);
		const tracked = await db
			.selectFrom("_plugin_indexes")
			.select(["index_name", "fields"])
			.where("plugin_id", "=", "shop")
			.where("collection", "=", "product-items")
			.execute();
		expect(tracked).toEqual(
			expect.arrayContaining([
				{ index_name: UNIQUE_NAME, fields: '["sku"]' },
				{ index_name: LOOKUP_NAME, fields: '["sku"]' },
			]),
		);
		expect((await indexNames(db)).some((name) => name.startsWith(TEMP_NAME))).toBe(false);
		await up(db);
		await assertScope(db);
	});

	it("handles composite camelCase fields, removed plugins, and more than one page of indexes", async () => {
		const db = getDb();
		const entries: IndexCase[] = [
			{
				plugin: "removed",
				collection: "old-items",
				name: "uidx_plugin_removed_old-items_orderNumber",
				fields: ["orderNumber"],
			},
			{
				plugin: "shop",
				collection: "product-items",
				name: UNIQUE_NAME,
				fields: ["region", "orderNumber"],
			},
		];
		for (const entry of entries) await seedLegacyIndex(db, entry);
		const pagedPlugin = `paged-${"x".repeat(65)}`;
		const pagedEntries: IndexCase[] = [];
		for (let i = 0; i < 101; i++) {
			const collection = `page-${String(i).padStart(3, "0")}`;
			const entry = {
				plugin: pagedPlugin,
				collection,
				name: `uidx_plugin_${pagedPlugin}_${collection}_sku`.substring(0, 128),
				fields: ["sku"],
			};
			pagedEntries.push(entry);
			await seedLegacyIndex(db, entry);
		}
		await put(db, "shop", "product-items", "owner", { region: "us", orderNumber: "A" });
		await up(db);
		await up(db);
		await put(db, "stock", "movements", "sku-one", { sku: "ABC" });
		await put(db, "stock", "movements", "sku-two", { sku: "ABC" });
		for (const collection of ["page-000", "page-100"]) {
			await put(db, pagedPlugin, collection, `${collection}-owner`, { sku: "ABC" });
			await expect(
				put(db, pagedPlugin, collection, `${collection}-duplicate`, { sku: "ABC" }),
			).rejects.toThrow();
		}
		await put(db, "stock", "movements", "one", { region: "us", orderNumber: "A" });
		await expect(
			put(db, "stock", "movements", "two", { region: "us", orderNumber: "A" }),
		).resolves.toBeUndefined();
		await expect(
			put(db, "shop", "product-items", "duplicate", { region: "us", orderNumber: "A" }),
		).rejects.toThrow();
		await expect(
			put(db, "removed", "old-items", "one", { orderNumber: "A" }),
		).resolves.toBeUndefined();
		const removedTracking = await db
			.selectFrom("_plugin_indexes")
			.select("index_name")
			.where("plugin_id", "=", "removed")
			.where("collection", "=", "old-items")
			.execute();
		expect(removedTracking.map((row) => row.index_name)).toContain(
			generateIndexName("removed", "old-items", ["orderNumber"]),
		);
		const expectedUniqueNames = [...entries, ...pagedEntries].map((entry) =>
			generateIndexName(entry.plugin, entry.collection, entry.fields, { unique: true }),
		);
		const trackedNames = await db
			.selectFrom("_plugin_indexes")
			.select("index_name")
			.where("index_name", "like", "uidx_plugin_%")
			.execute();
		expect(trackedNames.map((row) => row.index_name)).toEqual(
			expect.arrayContaining(expectedUniqueNames),
		);
		const indexes = await indexNames(db);
		expect(indexes.filter((name) => name.startsWith(TEMP_NAME))).toHaveLength(0);
		expect(indexes).toEqual(expect.arrayContaining(expectedUniqueNames));
	});

	it("separates short legacy names from colliding long legacy names", async () => {
		const db = getDb();
		const plugin = `shop-${"x".repeat(36)}`;
		const entries: IndexCase[] = [
			{
				plugin,
				collection: "items",
				name: `uidx_plugin_${plugin}_items_sku`,
				fields: ["sku"],
			},
			{
				plugin,
				collection: "items",
				name: `uidx_plugin_${plugin}_items_skuExtra`,
				fields: ["skuExtra"],
			},
		];
		await put(db, plugin, "items", "owner", { sku: "ABC", skuExtra: "EXTRA" });
		for (const entry of entries) await seedLegacyIndex(db, entry);

		await up(db);

		await expect(put(db, plugin, "items", "duplicate-sku", { sku: "ABC" })).rejects.toThrow();
		await expect(
			put(db, plugin, "items", "duplicate-sku-extra", { skuExtra: "EXTRA" }),
		).rejects.toThrow();
		await expect(
			put(db, "stock", "items", "crossscope-one", { sku: "ABC", skuExtra: "EXTRA" }),
		).resolves.toBeUndefined();
		await expect(
			put(db, "stock", "items", "crossscope-two", { sku: "ABC", skuExtra: "EXTRA" }),
		).resolves.toBeUndefined();
		const expectedUniqueNames = entries.map((entry) =>
			generateIndexName(entry.plugin, entry.collection, entry.fields, { unique: true }),
		);
		const indexes = await indexNames(db);
		expect(indexes).toEqual(expect.arrayContaining(expectedUniqueNames));
	});

	it("fails closed when a legacy unique field has existing duplicates", async () => {
		const db = getDb();
		const plugin = `shop-${"x".repeat(36)}`;
		const collection = "items";
		const sku = `uidx_plugin_${plugin}_${collection}_sku`;
		const skuExtra = `uidx_plugin_${plugin}_${collection}_skuExtra`;
		await put(db, plugin, collection, "one", { sku: "A", skuExtra: "FIRST" });
		await put(db, plugin, collection, "two", { sku: "B", skuExtra: "SECOND" });
		await seedLegacyIndex(db, { plugin, collection, name: sku, fields: ["sku"] });
		await seedLegacyIndex(db, { plugin, collection, name: skuExtra, fields: ["skuExtra"] });
		if (!isPostgres(db)) {
			await sql`DROP INDEX IF EXISTS ${sql.ref(skuExtra)}`.execute(db);
		}
		await db
			.updateTable("_plugin_storage")
			.set({ data: JSON.stringify({ sku: "B", skuExtra: "FIRST" }) })
			.where("plugin_id", "=", plugin)
			.where("collection", "=", collection)
			.where("id", "=", "two")
			.execute();

		await expect(up(db)).rejects.toThrow(
			`Failed to scope plugin storage unique index for ${plugin}/${collection} (skuExtra)`,
		);
		const rows = await db
			.selectFrom("_plugin_storage")
			.select(["id", "data"])
			.where("plugin_id", "=", plugin)
			.where("collection", "=", collection)
			.orderBy("id")
			.execute();
		expect(rows).toEqual([
			{ id: "one", data: JSON.stringify({ sku: "A", skuExtra: "FIRST" }) },
			{ id: "two", data: JSON.stringify({ sku: "B", skuExtra: "FIRST" }) },
		]);
		await expect(put(db, plugin, collection, "legacy-sku", { sku: "A" })).rejects.toThrow();

		await db
			.updateTable("_plugin_storage")
			.set({ data: JSON.stringify({ sku: "B", skuExtra: "FIXED" }) })
			.where("plugin_id", "=", plugin)
			.where("collection", "=", collection)
			.where("id", "=", "two")
			.execute();
		await up(db);
		await expect(put(db, plugin, collection, "duplicate-sku", { sku: "A" })).rejects.toThrow();
		await expect(
			put(db, plugin, collection, "duplicate-sku-extra", { skuExtra: "FIXED" }),
		).rejects.toThrow();
		await expect(
			put(db, "stock", "items", "crossscope-one", { sku: "A", skuExtra: "FIXED" }),
		).resolves.toBeUndefined();
		await expect(
			put(db, "stock", "items", "crossscope-two", { sku: "A", skuExtra: "FIXED" }),
		).resolves.toBeUndefined();
	});

	it("upgrades a movement log with 10000 rows and several unique fields", async () => {
		const db = getDb();
		await sql`
			WITH RECURSIVE sequence(n) AS (
				SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 10000
			)
			INSERT INTO _plugin_storage(plugin_id, collection, id, data)
			SELECT 'stock', 'movements', CAST(n AS TEXT),
				'{"sku":"S' || CAST(n AS TEXT) || '","orderNumber":"O' || CAST(n AS TEXT) || '","email":"E' || CAST(n AS TEXT) || '"}'
			FROM sequence
		`.execute(db);
		for (const field of ["sku", "orderNumber", "email"]) {
			await seedLegacyIndex(db, {
				plugin: "removed",
				collection: "items",
				name: `uidx_plugin_removed_items_${field}`,
				fields: [field],
			});
		}
		await up(db);
		await put(db, "stock", "movements", "repeat", { sku: "S1", orderNumber: "O1", email: "E1" });
		await put(db, "removed", "items", "owner", { sku: "S1", orderNumber: "O1", email: "E1" });
		await expect(put(db, "removed", "items", "duplicate", { sku: "S1" })).rejects.toThrow();
		const count = await db
			.selectFrom("_plugin_storage")
			.select(db.fn.countAll().as("n"))
			.executeTakeFirstOrThrow();
		expect(Number(count.n)).toBe(10002);
	});

	it("repairs long legacy names for every collection and keeps runtime sync idempotent", async () => {
		const db = getDb();
		const plugin = `shop-${"x".repeat(65)}`;
		const entries: IndexCase[] = [
			{ plugin, collection: "items", name: `uidx_plugin_${plugin}_items_sku`, fields: ["sku"] },
			{ plugin, collection: "orders", name: `uidx_plugin_${plugin}_orders_sku`, fields: ["sku"] },
		];
		for (const entry of entries) {
			await put(db, plugin, entry.collection, "owner", { sku: "ABC" });
			await seedLegacyIndex(db, entry);
		}
		await put(db, "stock", "items", "one", { sku: "ABC" });
		await expect(put(db, "stock", "items", "two", { sku: "ABC" })).rejects.toThrow();
		await up(db);
		await up(db);
		for (const collection of ["items", "orders"]) {
			await expect(put(db, plugin, collection, "duplicate", { sku: "ABC" })).rejects.toThrow();
			await expect(
				put(db, "stock", collection, "crossscope-1", { sku: "ABC" }),
			).resolves.toBeUndefined();
			await expect(
				put(db, "stock", collection, "crossscope-2", { sku: "ABC" }),
			).resolves.toBeUndefined();
		}
		for (const collection of ["items", "orders"]) {
			const result = await syncStorageIndexes(db, plugin, collection, ["sku"], {
				uniqueIndexes: ["sku"],
			});
			expect(result.errors).toEqual([]);
			expect(result.removed).toEqual([]);
		}
		const uniqueNames = entries.map((entry) =>
			generateIndexName(entry.plugin, entry.collection, ["sku"], { unique: true }),
		);
		expect(new Set(uniqueNames).size).toBe(2);
		expect(uniqueNames.every((name) => name.length <= 63)).toBe(true);
		const physical = (await indexNames(db)).filter((name) => uniqueNames.includes(name));
		expect(new Set(physical).size).toBe(2);
		expect((await indexNames(db)).some((index) => index.startsWith(TEMP_NAME))).toBe(false);
	});

	it.each(["shop", `shop-${"x".repeat(65)}`])(
		"can resume after every completed statement while retaining enforcement for %s",
		async (plugin) => {
			const db = getDb();
			const owners: IndexCase[] = [
				{ plugin, collection: "items", name: `uidx_plugin_${plugin}_items_sku`, fields: ["sku"] },
				{ plugin, collection: "Items", name: `uidx_plugin_${plugin}_Items_sku`, fields: ["sku"] },
				{
					plugin,
					collection: "orders",
					name: `uidx_plugin_${plugin}_orders_sku`,
					fields: ["sku"],
				},
			];
			const resetFixture = async () => {
				for (const name of await indexNames(db)) {
					if (
						name.startsWith("uidx_plugin_") ||
						name.startsWith("idx_plugin_") ||
						name.startsWith(TEMP_NAME)
					) {
						await sql`DROP INDEX IF EXISTS ${sql.ref(name)}`.execute(db);
					}
				}
				await db.deleteFrom("_plugin_indexes").execute();
				await db.deleteFrom("_plugin_storage").execute();
				for (const owner of owners) {
					await put(db, owner.plugin, owner.collection, "owner", { sku: "ABC" });
					await seedLegacyIndex(db, owner);
				}
			};
			await resetFixture();
			let statements = 0;
			await up(
				db.withPlugin({
					transformQuery: ({ node }) => node,
					transformResult: ({ result }) => {
						statements++;
						return Promise.resolve(result);
					},
				}),
			);
			for (let failure = 1; failure <= statements; failure++) {
				await resetFixture();
				await expect(up(db.withPlugin(failAfter(failure)))).rejects.toThrow(
					"lost migration response",
				);
				for (const owner of owners) {
					await expect(
						put(db, owner.plugin, owner.collection, `duplicate-${failure}`, { sku: "ABC" }),
					).rejects.toThrow();
				}
				await up(db);
				for (const owner of owners) {
					await expect(
						put(db, owner.plugin, owner.collection, `duplicate-after-${failure}`, { sku: "ABC" }),
					).rejects.toThrow();
				}
			}
		},
	);
}

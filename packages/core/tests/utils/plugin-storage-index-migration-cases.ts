import { type Kysely, type KyselyPlugin, sql } from "kysely";
import { expect, it } from "vitest";

import { isPostgres, jsonExtractExpr } from "../../src/database/dialect-helpers.js";
import { up } from "../../src/database/migrations/095_plugin_storage_unique_scope.js";
import type { Database } from "../../src/database/types.js";

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
		CREATE UNIQUE INDEX ${sql.ref(entry.name)}
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
		for (let i = 0; i < 101; i++) {
			const collection = `page-${String(i).padStart(3, "0")}`;
			await seedLegacyIndex(db, {
				plugin: "paged",
				collection,
				name: `uidx_plugin_paged_${collection}_sku`,
				fields: ["sku"],
			});
		}
		await put(db, "shop", "product-items", "owner", { region: "us", orderNumber: "A" });
		await up(db);
		await up(db);
		await put(db, "stock", "movements", "sku-one", { sku: "ABC" });
		await put(db, "stock", "movements", "sku-two", { sku: "ABC" });
		await put(db, "paged", "page-100", "last-owner", { sku: "ABC" });
		await expect(put(db, "paged", "page-100", "last-duplicate", { sku: "ABC" })).rejects.toThrow();
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
		expect(
			await db
				.selectFrom("_plugin_state")
				.select("plugin_id")
				.where("plugin_id", "=", "removed")
				.execute(),
		).toEqual([]);
		const indexes = await indexNames(db);
		expect(indexes.filter((name) => name.startsWith(TEMP_NAME))).toHaveLength(0);
		expect(indexes).toContain("uidx_plugin_paged_page-100_sku");
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

	it("repairs indexes whose tracked names exceed PostgreSQL's identifier limit", async () => {
		const db = getDb();
		const plugin = `shop-${"x".repeat(65)}`;
		const name = `uidx_plugin_${plugin}_items_sku`;
		await seedLegacyIndex(db, { plugin, collection: "items", name, fields: ["sku"] });
		await put(db, plugin, "items", "owner", { sku: "ABC" });
		await put(db, "stock", "items", "one", { sku: "ABC" });
		await expect(put(db, "stock", "items", "two", { sku: "ABC" })).rejects.toThrow();
		await up(db);
		await up(db);
		await put(db, "stock", "items", "two", { sku: "ABC" });
		await expect(put(db, plugin, "items", "duplicate", { sku: "ABC" })).rejects.toThrow();
		expect((await indexNames(db)).some((index) => index.startsWith(TEMP_NAME))).toBe(false);
	});

	it("can resume after every completed statement while retaining enforcement", async () => {
		const db = getDb();
		const owner: IndexCase = {
			plugin: "shop",
			collection: "items",
			name: "uidx_plugin_shop_items_sku",
			fields: ["sku"],
		};
		await put(db, "shop", "items", "owner", { sku: "ABC" });
		await seedLegacyIndex(db, owner);
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
			await sql`
				DELETE FROM _plugin_storage
				WHERE NOT (plugin_id = 'shop' AND collection = 'items' AND id = 'owner')
			`.execute(db);
			for (const name of await indexNames(db)) {
				if (
					name === UNIQUE_NAME ||
					name === "uidx_plugin_shop_items_sku" ||
					name.startsWith(TEMP_NAME) ||
					name === "idx_plugin_shop_items_sku"
				) {
					await sql`DROP INDEX IF EXISTS ${sql.ref(name)}`.execute(db);
				}
			}
			await db.deleteFrom("_plugin_indexes").where("plugin_id", "=", "shop").execute();
			await seedLegacyIndex(db, owner);
			await expect(up(db.withPlugin(failAfter(failure)))).rejects.toThrow(
				"lost migration response",
			);
			await expect(
				put(db, "shop", "items", `duplicate-${failure}`, { sku: "ABC" }),
			).rejects.toThrow();
			await up(db);
			await expect(
				put(db, "stock", "movements", `same-${failure}`, { sku: "ABC" }),
			).resolves.toBeUndefined();
			await expect(
				put(db, "shop", "items", `duplicate-after-${failure}`, { sku: "ABC" }),
			).rejects.toThrow();
		}
	});
}

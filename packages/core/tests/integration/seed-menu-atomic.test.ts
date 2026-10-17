import type { Kysely } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import type { Database } from "../../src/database/types.js";
import { applySeed } from "../../src/seed/apply.js";
import type { SeedFile, SeedMenuItem } from "../../src/seed/types.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../utils/test-db.js";

describeEachDialect("atomic seed menu replacement", (dialect) => {
	let db: Kysely<Database>;
	let context: DialectTestContext;

	beforeEach(async () => {
		context = await setupForDialect(dialect);
		db = context.db;
	});

	afterEach(async () => {
		await teardownForDialect(context);
	});

	const menuSeed = (items: SeedMenuItem[]): SeedFile => {
		return {
			version: "1",
			menus: [
				{
					name: "primary",
					label: "Primary",
					locale: "en",
					items,
				},
			],
		};
	};

	it("replaces nested items and reapplying leaves the exact item count", async () => {
		const seed = menuSeed([
			{
				id: "home",
				type: "custom",
				label: "Home",
				url: "/",
			},
			{
				id: "products",
				type: "custom",
				label: "Products",
				url: "/products",
				children: [{ id: "all", type: "custom", label: "All", url: "/products/all" }],
			},
		]);

		await applySeed(db, seed);
		await applySeed(db, seed);

		const items = await db
			.selectFrom("_emdash_menu_items")
			.select(["id", "label", "parent_id"])
			.orderBy("sort_order")
			.execute();
		expect(items).toHaveLength(3);
		expect(items.map((item) => item.label).toSorted()).toEqual(["All", "Home", "Products"]);
		const products = items.find((item) => item.label === "Products");
		const all = items.find((item) => item.label === "All");
		expect(all?.parent_id).toBe(products?.id);
	});

	it("clears existing items when the replacement menu is empty", async () => {
		await applySeed(db, menuSeed([{ type: "custom", label: "Existing", url: "/existing" }]));
		await applySeed(db, menuSeed([]));

		expect(await db.selectFrom("_emdash_menu_items").select("id").execute()).toEqual([]);
	});

	it("retains existing items when replacement insertion fails", async () => {
		await applySeed(db, menuSeed([{ type: "custom", label: "Original", url: "/" }]));
		let failed = false;
		const failingDb = db.withPlugin({
			transformQuery(args) {
				if (
					!failed &&
					args.node.kind === "InsertQueryNode" &&
					args.node.into?.table.identifier.name === "_emdash_menu_items"
				) {
					failed = true;
					throw new Error("seed menu item rejected");
				}
				return args.node;
			},
			async transformResult(args) {
				return args.result;
			},
		});

		await expect(
			applySeed(failingDb, menuSeed([{ type: "custom", label: "Replacement", url: "/new" }])),
		).rejects.toThrow("seed menu item rejected");
		expect(await db.selectFrom("_emdash_menu_items").select("label").execute()).toEqual([
			{ label: "Original" },
		]);
	});

	it.skipIf(dialect !== "postgres")(
		"serializes concurrent replacement of an existing menu",
		async () => {
			const seed = menuSeed([
				{ type: "custom", label: "Home", url: "/" },
				{ type: "custom", label: "About", url: "/about" },
			]);
			await applySeed(db, seed);
			await Promise.all([applySeed(db, seed), applySeed(db, seed)]);

			expect(await db.selectFrom("_emdash_menu_items").select("id").execute()).toHaveLength(2);
		},
	);
});

import type { Kysely, KyselyPlugin } from "kysely";
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

describeEachDialect("atomic seed menu and widget replacement", (dialect) => {
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

	const widgetSeed = (prefix: string): SeedFile => ({
		version: "1",
		widgetAreas: [
			{
				name: "sidebar",
				label: "Sidebar",
				widgets: [
					{
						type: "component",
						title: `${prefix}-sidebar-title`,
						componentId: `${prefix}-sidebar-component`,
					},
				],
			},
			{
				name: "footer",
				label: "Footer",
				widgets: [
					{
						type: "component",
						title: `${prefix}-footer-title`,
						componentId: `${prefix}-footer-component`,
					},
				],
			},
		],
	});

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

	it("serializes concurrent replacement of an existing menu", async () => {
		const seedA = menuSeed([
			{ type: "custom", label: "A Home", url: "/a" },
			{ type: "custom", label: "A About", url: "/a/about" },
		]);
		const seedB = menuSeed([
			{ type: "custom", label: "B Home", url: "/b" },
			{ type: "custom", label: "B About", url: "/b/about" },
		]);
		await applySeed(db, seedA);
		await Promise.all([
			applySeed(db, seedA, { onConflict: "skip" }),
			applySeed(db, seedB, { onConflict: "skip" }),
		]);

		const labels = (
			await db.selectFrom("_emdash_menu_items").select("label").orderBy("label").execute()
		).map((item) => item.label);
		expect(labels).toHaveLength(2);
		expect([
			["A About", "A Home"],
			["B About", "B Home"],
		]).toContainEqual(labels);
	});

	it("atomically replaces, reapplies, and clears widgets", async () => {
		await applySeed(db, widgetSeed("original"));
		await applySeed(db, widgetSeed("original"));
		expect(
			await db.selectFrom("_emdash_widgets").select("title").orderBy("title").execute(),
		).toEqual([{ title: "original-footer-title" }, { title: "original-sidebar-title" }]);
		await applySeed(db, {
			version: "1",
			widgetAreas: [
				{ name: "sidebar", label: "Sidebar", widgets: [] },
				{ name: "footer", label: "Footer", widgets: [] },
			],
		});

		expect(await db.selectFrom("_emdash_widgets").select("id").execute()).toEqual([]);
	});

	it("rolls back widget replacement across areas when insertion fails", async () => {
		await applySeed(db, widgetSeed("original"));
		const failingDb = db.withPlugin({
			transformQuery(args) {
				if (
					args.node.kind === "InsertQueryNode" &&
					args.node.into?.table.identifier.name === "_emdash_widgets"
				) {
					throw new Error("seed widget rejected");
				}
				return args.node;
			},
			async transformResult(args) {
				return args.result;
			},
		} satisfies KyselyPlugin);

		await expect(applySeed(failingDb, widgetSeed("replacement"))).rejects.toThrow(
			"seed widget rejected",
		);
		const widgets = await db
			.selectFrom("_emdash_widgets")
			.select(["title", "component_id"])
			.orderBy("title")
			.execute();
		expect(widgets).toEqual([
			{ title: "original-footer-title", component_id: "original-footer-component" },
			{ title: "original-sidebar-title", component_id: "original-sidebar-component" },
		]);
	});

	it("serializes concurrent replacement of existing widget areas", async () => {
		const seedA = widgetSeed("A");
		const seedB = widgetSeed("B");
		await applySeed(db, seedA);
		await Promise.all([
			applySeed(db, seedA, { onConflict: "skip" }),
			applySeed(db, seedB, { onConflict: "skip" }),
		]);

		const widgets = await db
			.selectFrom("_emdash_widgets")
			.select(["title", "component_id"])
			.orderBy("title")
			.execute();
		expect(widgets).toHaveLength(2);
		expect(
			widgets.every(
				(widget) => widget.title?.startsWith("A-") && widget.component_id?.startsWith("A-"),
			) ||
				widgets.every(
					(widget) => widget.title?.startsWith("B-") && widget.component_id?.startsWith("B-"),
				),
		).toBe(true);
	});

	it("handles concurrent creation of a fresh widget area", async () => {
		const seedA = {
			version: "1" as const,
			widgetAreas: [
				{
					name: "fresh",
					label: "Fresh",
					widgets: [{ type: "component" as const, title: "A-title", componentId: "A-component" }],
				},
			],
		};
		const seedB = {
			version: "1" as const,
			widgetAreas: [
				{
					name: "fresh",
					label: "Fresh",
					widgets: [{ type: "component" as const, title: "B-title", componentId: "B-component" }],
				},
			],
		};
		await expect(
			Promise.all([
				applySeed(db, seedA, { onConflict: "skip" }),
				applySeed(db, seedB, { onConflict: "skip" }),
			]),
		).resolves.toHaveLength(2);

		const widgets = await db
			.selectFrom("_emdash_widgets")
			.select(["title", "component_id"])
			.execute();
		expect(widgets).toHaveLength(1);
		expect(["A-title", "B-title"]).toContain(widgets[0]?.title);
	});
});

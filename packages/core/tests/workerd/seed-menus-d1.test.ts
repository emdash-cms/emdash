import { env } from "cloudflare:test";
import { Kysely, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { D1Adapter, RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { applySeed } from "../../src/seed/apply.js";
import type { SeedFile } from "../../src/seed/types.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

let db: Kysely<Database>;

beforeAll(() => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
});

beforeEach(async () => {
	await resetD1Schema(db);
	await runMigrations(db);
});

afterAll(async () => {
	await db.destroy();
});

const menusSeed: SeedFile = {
	version: "1",
	menus: [
		{
			id: "primary-en",
			name: "primary",
			label: "Primary",
			locale: "en",
			items: [
				{ id: "home-en", type: "custom", label: "Home", url: "/" },
				{
					id: "products-en",
					type: "custom",
					label: "Products",
					url: "/products",
					children: [{ id: "all-en", type: "custom", label: "All", url: "/products/all" }],
				},
			],
		},
		{
			id: "primary-fr",
			name: "primary",
			label: "Principal",
			locale: "fr",
			translationOf: "primary-en",
			items: [
				{ id: "home-fr", type: "custom", label: "Accueil", url: "/fr" },
				{
					id: "products-fr",
					type: "custom",
					label: "Produits",
					url: "/fr/products",
					translationOf: "products-en",
					children: [
						{
							id: "all-fr",
							type: "custom",
							label: "Tous",
							url: "/fr/products/all",
							translationOf: "all-en",
						},
					],
				},
			],
		},
	],
};

describe("applySeed menus on D1", () => {
	it("allows concurrent creation of the same menus", async () => {
		await Promise.all([applySeed(db, menusSeed), applySeed(db, menusSeed)]);
		expect(await db.selectFrom("_emdash_menus").select("id").execute()).toHaveLength(2);
		expect(await db.selectFrom("_emdash_menu_items").select("id").execute()).toHaveLength(6);
	});

	it("keeps nested and translated items consistent when two replacements reach D1 together", async () => {
		await applySeed(db, menusSeed);
		const first = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
		const second = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
		const ready = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let arrived = 0;
		const spies = [first, second].map((database) => {
			const adapter = database.getExecutor().adapter;
			if (!(adapter instanceof D1Adapter)) throw new Error("Expected D1 adapter");
			const execute = adapter.executeAtomicBatch.bind(adapter);
			return vi.spyOn(adapter, "executeAtomicBatch").mockImplementation(async (queries) => {
				if (++arrived === 2) ready.resolve();
				await release.promise;
				return execute(queries);
			});
		});
		try {
			const applications = Promise.all([applySeed(first, menusSeed), applySeed(second, menusSeed)]);
			try {
				await Promise.race([ready.promise, applications]);
			} finally {
				release.resolve();
			}
			await applications;
			expect(arrived).toBe(2);
		} finally {
			for (const spy of spies) spy.mockRestore();
			await Promise.all([first.destroy(), second.destroy()]);
		}

		const items = await db
			.selectFrom("_emdash_menu_items")
			.innerJoin("_emdash_menus", "_emdash_menus.id", "_emdash_menu_items.menu_id")
			.select([
				"_emdash_menus.locale",
				"_emdash_menu_items.id",
				"_emdash_menu_items.label",
				"_emdash_menu_items.parent_id",
				"_emdash_menu_items.translation_group",
			])
			.orderBy("_emdash_menus.locale")
			.orderBy("_emdash_menu_items.label")
			.execute();
		expect(items).toHaveLength(6);
		expect(items.map(({ locale, label }) => [locale, label])).toEqual([
			["en", "All"],
			["en", "Home"],
			["en", "Products"],
			["fr", "Accueil"],
			["fr", "Produits"],
			["fr", "Tous"],
		]);
		expect(items[0]?.parent_id).toBe(items[2]?.id);
		expect(items[5]?.parent_id).toBe(items[4]?.id);
		expect(items[2]?.translation_group).toBe(items[4]?.translation_group);
		expect(items[0]?.translation_group).toBe(items[5]?.translation_group);
	});

	it("replaces items across parameter-limited inserts and clears an empty menu", async () => {
		const seed: SeedFile = {
			version: "1",
			menus: [
				{
					name: "large",
					label: "Large",
					items: Array.from({ length: 13 }, (_, i) => ({
						type: "custom" as const,
						label: `Item ${i}`,
						url: `/${i}`,
						children: [{ type: "custom" as const, label: `Child ${i}`, url: `/${i}/child` }],
					})),
				},
			],
		};
		await applySeed(db, seed);
		await applySeed(db, seed);
		const items = await db.selectFrom("_emdash_menu_items").select(["id", "parent_id"]).execute();
		expect(items).toHaveLength(26);
		const ids = new Set(items.map((item) => item.id));
		for (const item of items) {
			if (item.parent_id) expect(ids.has(item.parent_id)).toBe(true);
		}
		await applySeed(db, { version: "1", menus: [{ name: "large", label: "Large", items: [] }] });
		expect(await db.selectFrom("_emdash_menu_items").select("id").execute()).toEqual([]);
	});

	it("retains existing items when an atomic replacement fails", async () => {
		const seed: SeedFile = {
			version: "1",
			menus: [
				{
					name: "primary",
					label: "Primary",
					items: [{ type: "custom", label: "Original", url: "/" }],
				},
			],
		};
		await applySeed(db, seed);
		await sql`
			CREATE TRIGGER fail_seed_menu_item
			BEFORE INSERT ON _emdash_menu_items
			WHEN NEW.label = 'Fail'
			BEGIN SELECT RAISE(ABORT, 'seed menu item rejected'); END
		`.execute(db);

		const replacement: SeedFile = {
			version: "1",
			menus: [
				{
					name: "primary",
					label: "Primary",
					items: [{ type: "custom", label: "Fail", url: "/fail" }],
				},
			],
		};
		await expect(applySeed(db, replacement)).rejects.toThrow("seed menu item rejected");
		expect(await db.selectFrom("_emdash_menu_items").select("label").execute()).toEqual([
			{ label: "Original" },
		]);
	});
});

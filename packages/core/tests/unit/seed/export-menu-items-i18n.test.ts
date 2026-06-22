import type { Kysely } from "kysely";
import { ulid } from "ulidx";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { exportSeed } from "../../../src/cli/commands/export-seed.js";
import type { Database } from "../../../src/database/types.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

async function insertMenu(
	db: Kysely<Database>,
	args: { id: string; name: string; label: string; locale: string; group: string },
) {
	const now = new Date().toISOString();
	await db
		.insertInto("_emdash_menus")
		.values({
			id: args.id,
			name: args.name,
			label: args.label,
			created_at: now,
			updated_at: now,
			locale: args.locale,
			translation_group: args.group,
		})
		.execute();
}

async function insertItem(
	db: Kysely<Database>,
	args: {
		id: string;
		menuId: string;
		label: string;
		url: string;
		sortOrder: number;
		locale: string;
		group: string;
	},
) {
	await db
		.insertInto("_emdash_menu_items")
		.values({
			id: args.id,
			menu_id: args.menuId,
			parent_id: null,
			sort_order: args.sortOrder,
			type: "custom",
			label: args.label,
			custom_url: args.url,
			created_at: new Date().toISOString(),
			locale: args.locale,
			translation_group: args.group,
		})
		.execute();
}

describe("exportSeed: SeedMenuItem i18n", () => {
	let db: Kysely<Database>;

	afterEach(async () => {
		await teardownTestDatabase(db);
		setI18nConfig(null);
	});

	describe("with i18n enabled", () => {
		beforeEach(async () => {
			setI18nConfig({ defaultLocale: "en", locales: ["en", "es"] });
			db = await setupTestDatabase();
		});

		it("emits stable ids and translationOf so EN items anchor ES translations", async () => {
			const enMenuId = ulid();
			const esMenuId = ulid();
			const enHomeId = ulid();
			const enAboutId = ulid();

			await insertMenu(db, {
				id: enMenuId,
				name: "primary",
				label: "Primary",
				locale: "en",
				group: enMenuId,
			});
			await insertMenu(db, {
				id: esMenuId,
				name: "primary",
				label: "Principal",
				locale: "es",
				group: enMenuId,
			});

			await insertItem(db, {
				id: enHomeId,
				menuId: enMenuId,
				label: "Home",
				url: "/",
				sortOrder: 0,
				locale: "en",
				group: enHomeId,
			});
			await insertItem(db, {
				id: enAboutId,
				menuId: enMenuId,
				label: "About",
				url: "/about",
				sortOrder: 1,
				locale: "en",
				group: enAboutId,
			});
			await insertItem(db, {
				id: ulid(),
				menuId: esMenuId,
				label: "Inicio",
				url: "/",
				sortOrder: 0,
				locale: "es",
				group: enHomeId,
			});
			await insertItem(db, {
				id: ulid(),
				menuId: esMenuId,
				label: "Acerca",
				url: "/about",
				sortOrder: 1,
				locale: "es",
				group: enAboutId,
			});

			const seed = await exportSeed(db);

			const enMenu = seed.menus?.find((m) => m.locale === "en");
			const esMenu = seed.menus?.find((m) => m.locale === "es");
			expect(enMenu?.id).toBe("menu:primary:en");
			expect(esMenu?.translationOf).toBe("menu:primary:en");

			const enItems = enMenu?.items ?? [];
			expect(enItems).toHaveLength(2);
			for (const item of enItems) {
				expect(item.locale).toBe("en");
				expect(item.translationOf).toBeUndefined();
				expect(item.id).toMatch(/^item:primary:[a-z-]+:en$/);
			}

			const esItems = esMenu?.items ?? [];
			expect(esItems).toHaveLength(2);
			const enItemIds = new Set(enItems.map((i) => i.id));
			for (const item of esItems) {
				expect(item.locale).toBe("es");
				expect(item.translationOf).toBeDefined();
				expect(enItemIds.has(item.translationOf!)).toBe(true);
			}

			// Pairing: Inicio links to Home, Acerca links to About.
			const enHome = enItems.find((i) => i.label === "Home");
			const enAbout = enItems.find((i) => i.label === "About");
			const esHome = esItems.find((i) => i.label === "Inicio");
			const esAbout = esItems.find((i) => i.label === "Acerca");
			expect(esHome?.translationOf).toBe(enHome?.id);
			expect(esAbout?.translationOf).toBe(enAbout?.id);
		});

		it("falls back to DB-id-suffixed seed id when sibling labels collide", async () => {
			const menuId = ulid();
			const a1 = ulid();
			const a2 = ulid();

			await insertMenu(db, {
				id: menuId,
				name: "primary",
				label: "Primary",
				locale: "en",
				group: menuId,
			});
			await insertItem(db, {
				id: a1,
				menuId,
				label: "Home",
				url: "/",
				sortOrder: 0,
				locale: "en",
				group: a1,
			});
			await insertItem(db, {
				id: a2,
				menuId,
				label: "Home",
				url: "/home",
				sortOrder: 1,
				locale: "en",
				group: a2,
			});

			const seed = await exportSeed(db);
			const items = seed.menus?.[0]?.items ?? [];
			expect(items).toHaveLength(2);
			expect(items[0]?.id).toBe("item:primary:home:en");
			expect(items[1]?.id).toBe(`item:primary:home:${a2}:en`);
		});
	});

	describe("with i18n disabled", () => {
		beforeEach(async () => {
			setI18nConfig({ defaultLocale: "en", locales: ["en"] });
			db = await setupTestDatabase();
		});

		it("omits id, locale, and translationOf on exported items", async () => {
			const menuId = ulid();
			const itemId = ulid();
			await insertMenu(db, {
				id: menuId,
				name: "primary",
				label: "Primary",
				locale: "en",
				group: menuId,
			});
			await insertItem(db, {
				id: itemId,
				menuId,
				label: "Home",
				url: "/",
				sortOrder: 0,
				locale: "en",
				group: itemId,
			});

			const seed = await exportSeed(db);
			const item = seed.menus?.[0]?.items?.[0];
			expect(item?.id).toBeUndefined();
			expect(item?.locale).toBeUndefined();
			expect(item?.translationOf).toBeUndefined();
			expect(item?.label).toBe("Home");
			expect(item?.url).toBe("/");
		});
	});
});

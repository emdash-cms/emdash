/**
 * MCP menu tools — comprehensive integration tests.
 *
 * Covers:
 *   - menu_list
 *   - menu_get
 *
 * Plus regression for bug #15 (no menu mutation tools — gap).
 */

import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { ulid } from "ulidx";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../../src/database/types.js";
import {
	connectMcpHarness,
	extractJson,
	extractText,
	type McpHarness,
} from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const ADMIN_ID = "user_admin";
const SUBSCRIBER_ID = "user_subscriber";

async function seedMenu(
	db: Kysely<Database>,
	name: string,
	label: string,
	items: Array<{
		label: string;
		url?: string;
		sort_order?: number;
		parent_id?: string | null;
	}> = [],
	options: { locale?: string; translationGroup?: string } = {},
): Promise<string> {
	const menuId = ulid();
	const now = new Date().toISOString();
	await db
		.insertInto("_emdash_menus" as never)
		.values({
			id: menuId,
			name,
			label,
			locale: options.locale ?? "en",
			translation_group: options.translationGroup ?? menuId,
			created_at: now,
			updated_at: now,
		} as never)
		.execute();

	for (const [i, item] of items.entries()) {
		await db
			.insertInto("_emdash_menu_items" as never)
			.values({
				id: ulid(),
				menu_id: menuId,
				label: item.label,
				custom_url: item.url ?? null,
				type: "custom",
				sort_order: item.sort_order ?? i,
				parent_id: item.parent_id ?? null,
				locale: options.locale ?? "en",
				created_at: now,
			} as never)
			.execute();
	}
	return menuId;
}

// ---------------------------------------------------------------------------
// menu_list
// ---------------------------------------------------------------------------

describe("menu_list", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("returns empty list when no menus exist", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "menu_list",
			arguments: {},
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const data = extractJson(result);
		expect(Array.isArray(data) ? data : []).toEqual([]);
	});

	it("lists multiple menus in alphabetical order", async () => {
		await seedMenu(db, "main", "Main Menu");
		await seedMenu(db, "footer", "Footer");
		await seedMenu(db, "sidebar", "Sidebar");

		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "menu_list",
			arguments: {},
		});
		const data = extractJson<Array<{ name: string; label: string }>>(result);
		expect(data.map((m) => m.name)).toEqual(["footer", "main", "sidebar"]);
	});

	it("itemCount reflects per-menu item count (LEFT JOIN correctness)", async () => {
		// handleMenuList uses a single LEFT JOIN + GROUP BY for the count.
		// A regression to INNER JOIN would drop empty menus; a regression
		// in the count column or join key would silently report wrong
		// numbers per menu. Seed three menus with known, distinct counts.
		await seedMenu(db, "empty", "Empty");
		await seedMenu(db, "single", "Single", [{ label: "Home", url: "/" }]);
		await seedMenu(db, "triple", "Triple", [
			{ label: "Home", url: "/" },
			{ label: "About", url: "/about" },
			{ label: "Blog", url: "/blog" },
		]);

		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({ name: "menu_list", arguments: {} });
		const data = extractJson<Array<{ name: string; itemCount: number }>>(result);

		const empty = data.find((m) => m.name === "empty");
		const single = data.find((m) => m.name === "single");
		const triple = data.find((m) => m.name === "triple");
		expect(empty?.itemCount).toBe(0);
		expect(single?.itemCount).toBe(1);
		expect(triple?.itemCount).toBe(3);
		// Empty menu must still be present — guards against an INNER JOIN
		// regression where it would disappear.
		expect(data.map((m) => m.name)).toContain("empty");
	});

	it("any logged-in user can list menus", async () => {
		await seedMenu(db, "main", "Main");
		harness = await connectMcpHarness({ db, userId: SUBSCRIBER_ID, userRole: Role.SUBSCRIBER });
		const result = await harness.client.callTool({
			name: "menu_list",
			arguments: {},
		});
		expect(result.isError, extractText(result)).toBeFalsy();
	});
});

// ---------------------------------------------------------------------------
// menu_get
// ---------------------------------------------------------------------------

describe("menu_get", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("returns menu with items in sort order", async () => {
		await seedMenu(db, "main", "Main", [
			{ label: "Home", url: "/", sort_order: 0 },
			{ label: "Blog", url: "/blog", sort_order: 1 },
			{ label: "About", url: "/about", sort_order: 2 },
		]);

		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "menu_get",
			arguments: { name: "main" },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const menu = extractJson<{
			name: string;
			items: Array<{ label: string; sort_order: number }>;
		}>(result);
		expect(menu.name).toBe("main");
		expect(menu.items).toHaveLength(3);
		expect(menu.items.map((i) => i.label)).toEqual(["Home", "Blog", "About"]);
	});

	it("returns NOT_FOUND error for missing menu", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "menu_get",
			arguments: { name: "ghost" },
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(/\bNOT_FOUND\b|\bnot found\b/i);
		expect(extractText(result)).toContain("ghost");
	});

	it("empty menu returns empty items array", async () => {
		await seedMenu(db, "empty", "Empty Menu", []);
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "menu_get",
			arguments: { name: "empty" },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const menu = extractJson<{ items: unknown[] }>(result);
		expect(menu.items).toEqual([]);
	});

	it("any logged-in user can get a menu", async () => {
		await seedMenu(db, "main", "Main", [{ label: "Home", url: "/" }]);
		harness = await connectMcpHarness({ db, userId: SUBSCRIBER_ID, userRole: Role.SUBSCRIBER });
		const result = await harness.client.callTool({
			name: "menu_get",
			arguments: { name: "main" },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
	});
});

// ---------------------------------------------------------------------------
// Bug #15 / F6 / F12 — happy paths for menu mutation tools.
// ---------------------------------------------------------------------------

describe("menu mutations (bug #15 / F6 / F12)", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("MCP exposes menu_create, menu_update, menu_set_items, menu_delete", async () => {
		const tools = await harness.client.listTools();
		const names = new Set(tools.tools.map((t) => t.name));
		expect(names.has("menu_create")).toBe(true);
		expect(names.has("menu_update")).toBe(true);
		expect(names.has("menu_set_items")).toBe(true);
		expect(names.has("menu_delete")).toBe(true);
	});

	it("menu_create + menu_get round-trip", async () => {
		const create = await harness.client.callTool({
			name: "menu_create",
			arguments: { name: "main", label: "Main Menu" },
		});
		expect(create.isError, extractText(create)).toBeFalsy();

		const get = await harness.client.callTool({
			name: "menu_get",
			arguments: { name: "main" },
		});
		expect(get.isError, extractText(get)).toBeFalsy();
		const menu = extractJson<{ name: string; label: string; items: unknown[] }>(get);
		expect(menu.name).toBe("main");
		expect(menu.label).toBe("Main Menu");
		expect(menu.items).toEqual([]);
	});

	it("menu_create forwards locale and translationOf", async () => {
		const createSource = await harness.client.callTool({
			name: "menu_create",
			arguments: { name: "main", label: "Main Menu", locale: "en" },
		});
		expect(createSource.isError, extractText(createSource)).toBeFalsy();

		const sourceMenu = await db
			.selectFrom("_emdash_menus")
			.select(["id", "translation_group"])
			.where("name", "=", "main")
			.where("locale", "=", "en")
			.executeTakeFirstOrThrow();

		const createTranslation = await harness.client.callTool({
			name: "menu_create",
			arguments: {
				name: "main",
				label: "Menu principal",
				locale: "fr-fr",
				translationOf: sourceMenu.id,
			},
		});
		expect(createTranslation.isError, extractText(createTranslation)).toBeFalsy();

		const frMenu = await harness.client.callTool({
			name: "menu_get",
			arguments: { name: "main", locale: "fr-fr" },
		});
		expect(frMenu.isError, extractText(frMenu)).toBeFalsy();
		const menu = extractJson<{ label: string; locale: string }>(frMenu);
		expect(menu.label).toBe("Menu principal");
		expect(menu.locale).toBe("fr-fr");

		const translatedRow = await db
			.selectFrom("_emdash_menus")
			.select(["translation_group"])
			.where("name", "=", "main")
			.where("locale", "=", "fr-fr")
			.executeTakeFirstOrThrow();
		expect(translatedRow.translation_group).toBe(sourceMenu.translation_group);
	});

	it("menu_create requires locale when translationOf is provided", async () => {
		const createSource = await harness.client.callTool({
			name: "menu_create",
			arguments: { name: "main", label: "Main Menu", locale: "en" },
		});
		expect(createSource.isError, extractText(createSource)).toBeFalsy();

		const sourceMenu = await db
			.selectFrom("_emdash_menus")
			.select("id")
			.where("name", "=", "main")
			.where("locale", "=", "en")
			.executeTakeFirstOrThrow();

		const missingLocale = await harness.client.callTool({
			name: "menu_create",
			arguments: {
				name: "main",
				label: "Menu principal",
				translationOf: sourceMenu.id,
			},
		});
		expect(missingLocale.isError).toBe(true);
		expect(extractText(missingLocale)).toMatch(/locale/i);
		expect(extractText(missingLocale)).toMatch(/translationOf/i);
	});

	it("menu_create with a duplicate name returns CONFLICT", async () => {
		await harness.client.callTool({
			name: "menu_create",
			arguments: { name: "main", label: "Main" },
		});
		const dup = await harness.client.callTool({
			name: "menu_create",
			arguments: { name: "main", label: "Other" },
		});
		expect(dup.isError).toBe(true);
		expect(extractText(dup)).toMatch(/CONFLICT|already exists/i);
	});

	it("menu_update changes the label", async () => {
		await harness.client.callTool({
			name: "menu_create",
			arguments: { name: "main", label: "Original" },
		});
		const update = await harness.client.callTool({
			name: "menu_update",
			arguments: { name: "main", label: "Renamed" },
		});
		expect(update.isError, extractText(update)).toBeFalsy();

		const get = await harness.client.callTool({
			name: "menu_get",
			arguments: { name: "main" },
		});
		const menu = extractJson<{ label: string }>(get);
		expect(menu.label).toBe("Renamed");
	});

	it("menu_update with locale only changes the targeted translation", async () => {
		const translationGroup = ulid();
		await seedMenu(db, "main", "Main", [], { locale: "en", translationGroup });
		await seedMenu(db, "main", "Principal", [], { locale: "fr-fr", translationGroup });

		const update = await harness.client.callTool({
			name: "menu_update",
			arguments: { name: "main", locale: "fr-fr", label: "Menu principal" },
		});
		expect(update.isError, extractText(update)).toBeFalsy();

		const enMenu = await harness.client.callTool({
			name: "menu_get",
			arguments: { name: "main", locale: "en" },
		});
		const frMenu = await harness.client.callTool({
			name: "menu_get",
			arguments: { name: "main", locale: "fr-fr" },
		});
		expect(extractJson<{ label: string }>(enMenu).label).toBe("Main");
		expect(extractJson<{ label: string }>(frMenu).label).toBe("Menu principal");
	});

	it("menu_set_items with empty list clears all items", async () => {
		await seedMenu(db, "main", "Main", [
			{ label: "Home", url: "/" },
			{ label: "Blog", url: "/blog" },
		]);

		const result = await harness.client.callTool({
			name: "menu_set_items",
			arguments: { name: "main", items: [] },
		});
		expect(result.isError, extractText(result)).toBeFalsy();

		const get = await harness.client.callTool({
			name: "menu_get",
			arguments: { name: "main" },
		});
		const menu = extractJson<{ items: unknown[] }>(get);
		expect(menu.items).toEqual([]);
	});

	it("menu_set_items with locale only replaces that locale's items", async () => {
		const translationGroup = ulid();
		await seedMenu(
			db,
			"main",
			"Main",
			[
				{ label: "Home", url: "/en" },
				{ label: "Docs", url: "/en/docs" },
			],
			{ locale: "en", translationGroup },
		);
		await seedMenu(db, "main", "Principal", [{ label: "Ancien", url: "/fr/ancien" }], {
			locale: "fr-fr",
			translationGroup,
		});

		const result = await harness.client.callTool({
			name: "menu_set_items",
			arguments: {
				name: "main",
				locale: "fr-fr",
				items: [
					{ label: "Accueil", type: "custom", customUrl: "/fr" },
					{ label: "Guides", type: "custom", customUrl: "/fr/guides", parentIndex: 0 },
				],
			},
		});
		expect(result.isError, extractText(result)).toBeFalsy();

		const enMenu = await harness.client.callTool({
			name: "menu_get",
			arguments: { name: "main", locale: "en" },
		});
		const frMenu = await harness.client.callTool({
			name: "menu_get",
			arguments: { name: "main", locale: "fr-fr" },
		});
		expect(
			extractJson<{ items: Array<{ label: string }> }>(enMenu).items.map((item) => item.label),
		).toEqual(["Home", "Docs"]);
		expect(
			extractJson<{ items: Array<{ label: string }> }>(frMenu).items.map((item) => item.label),
		).toEqual(["Accueil", "Guides"]);

		const frItemLocales = await db
			.selectFrom("_emdash_menu_items" as never)
			.select(["locale" as never])
			.where(
				"menu_id" as never,
				"=",
				(
					await db
						.selectFrom("_emdash_menus" as never)
						.select("id" as never)
						.where("name" as never, "=", "main" as never)
						.where("locale" as never, "=", "fr-fr" as never)
						.executeTakeFirstOrThrow()
				).id as never,
			)
			.orderBy("sort_order" as never, "asc")
			.execute();
		expect(frItemLocales.every((item) => item.locale === "fr-fr")).toBe(true);
	});

	it("menu_set_items supports 3-level nesting via parentIndex chain", async () => {
		await harness.client.callTool({
			name: "menu_create",
			arguments: { name: "main", label: "Main" },
		});

		const result = await harness.client.callTool({
			name: "menu_set_items",
			arguments: {
				name: "main",
				items: [
					{ label: "Root", type: "custom", customUrl: "/" },
					{ label: "Child", type: "custom", customUrl: "/child", parentIndex: 0 },
					{ label: "Grandchild", type: "custom", customUrl: "/gc", parentIndex: 1 },
				],
			},
		});
		expect(result.isError, extractText(result)).toBeFalsy();

		const get = await harness.client.callTool({
			name: "menu_get",
			arguments: { name: "main" },
		});
		const menu = extractJson<{
			items: Array<{ id: string; label: string; parent_id: string | null; sort_order: number }>;
		}>(get);
		expect(menu.items).toHaveLength(3);

		const byLabel = new Map(menu.items.map((i) => [i.label, i]));
		const root = byLabel.get("Root");
		const child = byLabel.get("Child");
		const grand = byLabel.get("Grandchild");
		expect(root?.parent_id).toBeNull();
		expect(child?.parent_id).toBe(root?.id);
		expect(grand?.parent_id).toBe(child?.id);
	});

	it("menu_set_items rejects parentIndex >= i (must be earlier)", async () => {
		await harness.client.callTool({
			name: "menu_create",
			arguments: { name: "main", label: "Main" },
		});
		const result = await harness.client.callTool({
			name: "menu_set_items",
			arguments: {
				name: "main",
				items: [
					{ label: "A", type: "custom", customUrl: "/a", parentIndex: 0 }, // self-ref
				],
			},
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(/VALIDATION_ERROR|parentIndex/);
	});

	it("F6: menu_delete removes both menu and items (D1 cascade safe)", async () => {
		await harness.client.callTool({
			name: "menu_create",
			arguments: { name: "main", label: "Main" },
		});
		await harness.client.callTool({
			name: "menu_set_items",
			arguments: {
				name: "main",
				items: [
					{ label: "A", type: "custom", customUrl: "/a" },
					{ label: "B", type: "custom", customUrl: "/b" },
					{ label: "C", type: "custom", customUrl: "/c" },
				],
			},
		});

		// Sanity: menu_get sees 3 items.
		const before = await harness.client.callTool({
			name: "menu_get",
			arguments: { name: "main" },
		});
		const menuBefore = extractJson<{
			id: string;
			items: unknown[];
		}>(before);
		expect(menuBefore.items).toHaveLength(3);

		// Delete.
		const del = await harness.client.callTool({
			name: "menu_delete",
			arguments: { name: "main" },
		});
		expect(del.isError, extractText(del)).toBeFalsy();

		// Items table is empty for that menu_id.
		const orphans = await db
			.selectFrom("_emdash_menu_items" as never)
			.select(["id" as never])
			.where("menu_id" as never, "=", menuBefore.id as never)
			.execute();
		expect(orphans).toEqual([]);

		// menu_get returns NOT_FOUND.
		const after = await harness.client.callTool({
			name: "menu_get",
			arguments: { name: "main" },
		});
		expect(after.isError).toBe(true);
		expect(extractText(after)).toMatch(/NOT_FOUND/);
	});

	it("menu_delete with locale only removes the targeted translation", async () => {
		const translationGroup = ulid();
		await seedMenu(db, "main", "Main", [{ label: "Home", url: "/en" }], {
			locale: "en",
			translationGroup,
		});
		await seedMenu(db, "main", "Principal", [{ label: "Accueil", url: "/fr" }], {
			locale: "fr-fr",
			translationGroup,
		});

		const del = await harness.client.callTool({
			name: "menu_delete",
			arguments: { name: "main", locale: "fr-fr" },
		});
		expect(del.isError, extractText(del)).toBeFalsy();

		const enMenu = await harness.client.callTool({
			name: "menu_get",
			arguments: { name: "main", locale: "en" },
		});
		expect(enMenu.isError, extractText(enMenu)).toBeFalsy();

		const frMenu = await harness.client.callTool({
			name: "menu_get",
			arguments: { name: "main", locale: "fr-fr" },
		});
		expect(frMenu.isError).toBe(true);
		expect(extractText(frMenu)).toMatch(/NOT_FOUND/);
	});

	// -------------------------------------------------------------------
	// Multi-locale ambiguity (fail loud)
	// -------------------------------------------------------------------
	// Background: prior to the AMBIGUOUS_LOCALE fix, calling menu_update /
	// menu_delete / menu_set_items on a multi-locale install without a
	// `locale` arg silently picked an arbitrary translation. Now the
	// handler returns a structured error and the caller has to disambiguate.

	it("menu_update without locale on a multi-locale install returns AMBIGUOUS_LOCALE", async () => {
		const translationGroup = ulid();
		await seedMenu(db, "main", "Main", [], { locale: "en", translationGroup });
		await seedMenu(db, "main", "Principal", [], { locale: "fr-fr", translationGroup });

		const result = await harness.client.callTool({
			name: "menu_update",
			arguments: { name: "main", label: "Whatever" },
		});
		expect(result.isError).toBe(true);
		const text = extractText(result);
		expect(text).toMatch(/AMBIGUOUS_LOCALE/);
		expect(text).toMatch(/multiple locales/);
		expect(text).toMatch(/en/);
		expect(text).toMatch(/fr-fr/);

		// Both labels untouched — the ambiguous call must not have written.
		const en = await harness.client.callTool({
			name: "menu_get",
			arguments: { name: "main", locale: "en" },
		});
		const fr = await harness.client.callTool({
			name: "menu_get",
			arguments: { name: "main", locale: "fr-fr" },
		});
		expect(extractJson<{ label: string }>(en).label).toBe("Main");
		expect(extractJson<{ label: string }>(fr).label).toBe("Principal");
	});

	it("menu_delete without locale on a multi-locale install returns AMBIGUOUS_LOCALE", async () => {
		const translationGroup = ulid();
		await seedMenu(db, "main", "Main", [], { locale: "en", translationGroup });
		await seedMenu(db, "main", "Principal", [], { locale: "fr-fr", translationGroup });

		const result = await harness.client.callTool({
			name: "menu_delete",
			arguments: { name: "main" },
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(/AMBIGUOUS_LOCALE/);

		// Both translations must still exist.
		const en = await harness.client.callTool({
			name: "menu_get",
			arguments: { name: "main", locale: "en" },
		});
		const fr = await harness.client.callTool({
			name: "menu_get",
			arguments: { name: "main", locale: "fr-fr" },
		});
		expect(en.isError, extractText(en)).toBeFalsy();
		expect(fr.isError, extractText(fr)).toBeFalsy();
	});

	it("menu_set_items without locale on a multi-locale install returns AMBIGUOUS_LOCALE", async () => {
		const translationGroup = ulid();
		await seedMenu(db, "main", "Main", [{ label: "Keep", url: "/en/keep" }], {
			locale: "en",
			translationGroup,
		});
		await seedMenu(db, "main", "Principal", [{ label: "Garder", url: "/fr/garder" }], {
			locale: "fr-fr",
			translationGroup,
		});

		const result = await harness.client.callTool({
			name: "menu_set_items",
			arguments: {
				name: "main",
				items: [{ label: "New", type: "custom", customUrl: "/new" }],
			},
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(/AMBIGUOUS_LOCALE/);

		// Neither translation's items were touched — transaction rolled back.
		const en = await harness.client.callTool({
			name: "menu_get",
			arguments: { name: "main", locale: "en" },
		});
		const fr = await harness.client.callTool({
			name: "menu_get",
			arguments: { name: "main", locale: "fr-fr" },
		});
		expect(extractJson<{ items: Array<{ label: string }> }>(en).items.map((i) => i.label)).toEqual([
			"Keep",
		]);
		expect(extractJson<{ items: Array<{ label: string }> }>(fr).items.map((i) => i.label)).toEqual([
			"Garder",
		]);
	});
});

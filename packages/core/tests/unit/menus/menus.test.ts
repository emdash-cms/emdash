import type { Kysely } from "kysely";
import { ulid } from "ulidx";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createMenuItemBody, updateMenuItemBody } from "../../../src/api/schemas/menus.js";
import { createDatabase } from "../../../src/database/connection.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database } from "../../../src/database/types.js";
import { getMenuWithDb, getMenusWithDb } from "../../../src/menus/index.js";
import { sanitizeHref } from "../../../src/utils/url.js";

describe("Navigation Menus", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		// Fresh in-memory database for each test
		db = createDatabase({ url: ":memory:" });
		await runMigrations(db);
	});

	afterEach(async () => {
		await db.destroy();
	});

	describe("migration", () => {
		it("should create _emdash_menus table", async () => {
			const tables = await db.introspection.getTables();
			const menusTable = tables.find((t) => t.name === "_emdash_menus");
			expect(menusTable).toBeDefined();

			const columns = menusTable!.columns.map((c) => c.name);
			expect(columns).toContain("id");
			expect(columns).toContain("name");
			expect(columns).toContain("label");
			expect(columns).toContain("created_at");
			expect(columns).toContain("updated_at");
		});

		it("should create _emdash_menu_items table", async () => {
			const tables = await db.introspection.getTables();
			const itemsTable = tables.find((t) => t.name === "_emdash_menu_items");
			expect(itemsTable).toBeDefined();

			const columns = itemsTable!.columns.map((c) => c.name);
			expect(columns).toContain("id");
			expect(columns).toContain("menu_id");
			expect(columns).toContain("parent_id");
			expect(columns).toContain("sort_order");
			expect(columns).toContain("type");
			expect(columns).toContain("reference_collection");
			expect(columns).toContain("reference_id");
			expect(columns).toContain("custom_url");
			expect(columns).toContain("label");
			expect(columns).toContain("target");
			expect(columns).toContain("css_classes");
		});

		it("should enforce unique constraint on menu name", async () => {
			const id1 = ulid();
			const id2 = ulid();

			await db
				.insertInto("_emdash_menus")
				.values({
					id: id1,
					name: "primary",
					label: "Primary Navigation",
				})
				.execute();

			await expect(
				db
					.insertInto("_emdash_menus")
					.values({
						id: id2,
						name: "primary",
						label: "Primary Again",
					})
					.execute(),
			).rejects.toThrow();
		});

		it("should cascade delete menu items when menu is deleted", async () => {
			const menuId = ulid();
			const itemId = ulid();

			// Create menu
			await db
				.insertInto("_emdash_menus")
				.values({
					id: menuId,
					name: "test-menu",
					label: "Test Menu",
				})
				.execute();

			// Create menu item
			await db
				.insertInto("_emdash_menu_items")
				.values({
					id: itemId,
					menu_id: menuId,
					sort_order: 0,
					type: "custom",
					custom_url: "https://example.com",
					label: "Test Link",
				})
				.execute();

			// Delete menu
			await db.deleteFrom("_emdash_menus").where("id", "=", menuId).execute();

			// Verify item was deleted
			const items = await db
				.selectFrom("_emdash_menu_items")
				.where("menu_id", "=", menuId)
				.selectAll()
				.execute();

			expect(items).toHaveLength(0);
		});
	});

	describe("getMenus", () => {
		it("should return empty array when no menus exist", async () => {
			const menus = await getMenusWithDb(db);
			expect(menus).toEqual([]);
		});

		it("should return all menus ordered by name", async () => {
			await db
				.insertInto("_emdash_menus")
				.values([
					{ id: ulid(), name: "footer", label: "Footer Links" },
					{ id: ulid(), name: "primary", label: "Primary Navigation" },
					{ id: ulid(), name: "social", label: "Social Links" },
				])
				.execute();

			const menus = await getMenusWithDb(db);
			expect(menus).toHaveLength(3);
			expect(menus[0].name).toBe("footer");
			expect(menus[1].name).toBe("primary");
			expect(menus[2].name).toBe("social");
		});
	});

	describe("getMenu", () => {
		it("should return null for non-existent menu", async () => {
			const menu = await getMenuWithDb("nonexistent", db);
			expect(menu).toBeNull();
		});

		it("should return menu with empty items array", async () => {
			const menuId = ulid();
			await db
				.insertInto("_emdash_menus")
				.values({
					id: menuId,
					name: "primary",
					label: "Primary Navigation",
				})
				.execute();

			const menu = await getMenuWithDb("primary", db);
			expect(menu).toMatchObject({
				id: menuId,
				name: "primary",
				label: "Primary Navigation",
				items: [],
			});
		});

		it("should resolve custom URLs correctly", async () => {
			const menuId = ulid();
			const itemId = ulid();

			await db
				.insertInto("_emdash_menus")
				.values({
					id: menuId,
					name: "primary",
					label: "Primary Navigation",
				})
				.execute();

			await db
				.insertInto("_emdash_menu_items")
				.values({
					id: itemId,
					menu_id: menuId,
					sort_order: 0,
					type: "custom",
					custom_url: "https://github.com",
					label: "GitHub",
					target: "_blank",
				})
				.execute();

			const menu = await getMenuWithDb("primary", db);
			expect(menu).not.toBeNull();
			expect(menu!.items).toHaveLength(1);
			expect(menu!.items[0]).toMatchObject({
				id: itemId,
				label: "GitHub",
				url: "https://github.com",
				target: "_blank",
			});
		});

		it("should sanitize dangerous URLs from the database", async () => {
			const menuId = ulid();
			const itemId = ulid();

			await db
				.insertInto("_emdash_menus")
				.values({ id: menuId, name: "primary", label: "Primary" })
				.execute();

			await db
				.insertInto("_emdash_menu_items")
				.values({
					id: itemId,
					menu_id: menuId,
					sort_order: 0,
					type: "custom",
					custom_url: "javascript:alert(1)",
					label: "XSS",
				})
				.execute();

			const menu = await getMenuWithDb("primary", db);
			expect(menu).not.toBeNull();
			expect(menu!.items).toHaveLength(1);
			expect(menu!.items[0].url).toBe("#");
		});

		it("should sanitize data: URLs from the database", async () => {
			const menuId = ulid();
			const itemId = ulid();

			await db
				.insertInto("_emdash_menus")
				.values({ id: menuId, name: "primary", label: "Primary" })
				.execute();

			await db
				.insertInto("_emdash_menu_items")
				.values({
					id: itemId,
					menu_id: menuId,
					sort_order: 0,
					type: "custom",
					custom_url: "data:text/html,<script>alert(1)</script>",
					label: "XSS",
				})
				.execute();

			const menu = await getMenuWithDb("primary", db);
			expect(menu).not.toBeNull();
			expect(menu!.items).toHaveLength(1);
			expect(menu!.items[0].url).toBe("#");
		});

		it("should sanitize vbscript: URLs from the database", async () => {
			const menuId = ulid();
			const itemId = ulid();

			await db
				.insertInto("_emdash_menus")
				.values({ id: menuId, name: "primary", label: "Primary" })
				.execute();

			await db
				.insertInto("_emdash_menu_items")
				.values({
					id: itemId,
					menu_id: menuId,
					sort_order: 0,
					type: "custom",
					custom_url: "vbscript:MsgBox",
					label: "XSS",
				})
				.execute();

			const menu = await getMenuWithDb("primary", db);
			expect(menu).not.toBeNull();
			expect(menu!.items).toHaveLength(1);
			expect(menu!.items[0].url).toBe("#");
		});

		it("should skip items with deleted content references", async () => {
			const menuId = ulid();
			const itemId = ulid();

			// Create menu with item referencing non-existent content
			await db
				.insertInto("_emdash_menus")
				.values({
					id: menuId,
					name: "primary",
					label: "Primary Navigation",
				})
				.execute();

			await db
				.insertInto("_emdash_menu_items")
				.values({
					id: itemId,
					menu_id: menuId,
					sort_order: 0,
					type: "page",
					reference_collection: "pages",
					reference_id: "nonexistent",
					label: "Deleted Page",
				})
				.execute();

			const menu = await getMenuWithDb("primary", db);
			expect(menu).not.toBeNull();
			// Item should be filtered out because the page doesn't exist
			expect(menu!.items).toHaveLength(0);
		});

		it("should build nested tree structure", async () => {
			const menuId = ulid();
			const parentId = ulid();
			const childId = ulid();

			await db
				.insertInto("_emdash_menus")
				.values({
					id: menuId,
					name: "primary",
					label: "Primary Navigation",
				})
				.execute();

			// Create parent item
			await db
				.insertInto("_emdash_menu_items")
				.values({
					id: parentId,
					menu_id: menuId,
					sort_order: 0,
					type: "custom",
					custom_url: "/about",
					label: "About",
				})
				.execute();

			// Create child item
			await db
				.insertInto("_emdash_menu_items")
				.values({
					id: childId,
					menu_id: menuId,
					parent_id: parentId,
					sort_order: 0,
					type: "custom",
					custom_url: "/about/team",
					label: "Team",
				})
				.execute();

			const menu = await getMenuWithDb("primary", db);
			expect(menu).not.toBeNull();
			expect(menu!.items).toHaveLength(1);
			expect(menu!.items[0].label).toBe("About");
			expect(menu!.items[0].children).toHaveLength(1);
			expect(menu!.items[0].children[0].label).toBe("Team");
		});

		it("should order items by sort_order", async () => {
			const menuId = ulid();

			await db
				.insertInto("_emdash_menus")
				.values({
					id: menuId,
					name: "primary",
					label: "Primary Navigation",
				})
				.execute();

			await db
				.insertInto("_emdash_menu_items")
				.values([
					{
						id: ulid(),
						menu_id: menuId,
						sort_order: 2,
						type: "custom",
						custom_url: "/contact",
						label: "Contact",
					},
					{
						id: ulid(),
						menu_id: menuId,
						sort_order: 0,
						type: "custom",
						custom_url: "/home",
						label: "Home",
					},
					{
						id: ulid(),
						menu_id: menuId,
						sort_order: 1,
						type: "custom",
						custom_url: "/about",
						label: "About",
					},
				])
				.execute();

			const menu = await getMenuWithDb("primary", db);
			expect(menu).not.toBeNull();
			expect(menu!.items).toHaveLength(3);
			expect(menu!.items[0].label).toBe("Home");
			expect(menu!.items[1].label).toBe("About");
			expect(menu!.items[2].label).toBe("Contact");
		});
	});

	describe("menu item URL validation", () => {
		it("should reject javascript: URLs", () => {
			const result = createMenuItemBody.safeParse({
				type: "custom",
				label: "XSS",
				customUrl: "javascript:alert(1)",
			});
			expect(result.success).toBe(false);
		});

		it("should reject data: URLs", () => {
			const result = createMenuItemBody.safeParse({
				type: "custom",
				label: "XSS",
				customUrl: "data:text/html,<script>alert(1)</script>",
			});
			expect(result.success).toBe(false);
		});

		it("should reject vbscript: URLs", () => {
			const result = createMenuItemBody.safeParse({
				type: "custom",
				label: "XSS",
				customUrl: "vbscript:MsgBox",
			});
			expect(result.success).toBe(false);
		});

		it("should allow https URLs", () => {
			const result = createMenuItemBody.safeParse({
				type: "custom",
				label: "Link",
				customUrl: "https://example.com",
			});
			expect(result.success).toBe(true);
		});

		it("should allow relative paths", () => {
			const result = createMenuItemBody.safeParse({
				type: "custom",
				label: "Link",
				customUrl: "/about",
			});
			expect(result.success).toBe(true);
		});

		it("should allow fragment links", () => {
			const result = createMenuItemBody.safeParse({
				type: "custom",
				label: "Link",
				customUrl: "#section",
			});
			expect(result.success).toBe(true);
		});

		it("should reject case-varied javascript: URLs", () => {
			const result = createMenuItemBody.safeParse({
				type: "custom",
				label: "XSS",
				customUrl: "JAVASCRIPT:alert(1)",
			});
			expect(result.success).toBe(false);
		});

		it("should allow mailto URLs", () => {
			const result = createMenuItemBody.safeParse({
				type: "custom",
				label: "Email",
				customUrl: "mailto:user@example.com",
			});
			expect(result.success).toBe(true);
		});

		it("should reject javascript: in update schema", () => {
			const result = updateMenuItemBody.safeParse({
				customUrl: "javascript:alert(1)",
			});
			expect(result.success).toBe(false);
		});

		it("should allow tel: URLs", () => {
			const result = createMenuItemBody.safeParse({
				type: "custom",
				label: "Call",
				customUrl: "tel:+15551234567",
			});
			expect(result.success).toBe(true);
		});

		it("should reject empty string URLs", () => {
			const result = createMenuItemBody.safeParse({
				type: "custom",
				label: "Link",
				customUrl: "",
			});
			expect(result.success).toBe(false);
		});

		it("should trim whitespace before validating", () => {
			const result = createMenuItemBody.safeParse({
				type: "custom",
				label: "Link",
				customUrl: "  https://example.com  ",
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.customUrl).toBe("https://example.com");
			}
		});

		it("should reject whitespace-prefixed javascript: after trim", () => {
			const result = createMenuItemBody.safeParse({
				type: "custom",
				label: "XSS",
				customUrl: "  javascript:alert(1)",
			});
			expect(result.success).toBe(false);
		});
	});

	describe("sanitizeHref", () => {
		it("should return # for null input", () => {
			expect(sanitizeHref(null)).toBe("#");
		});

		it("should return # for undefined input", () => {
			expect(sanitizeHref(undefined)).toBe("#");
		});
	});

	describe("handleMenuSetItems", () => {
		// The MCP boundary uses Zod with `.nonnegative()` so callers can't
		// pass a negative `parentIndex` from there. Direct handler callers
		// (REST routes, future programmatic users) bypass that guard, so
		// the handler enforces the same constraint.

		async function setupMenu(name: string): Promise<string> {
			const id = ulid();
			await db.insertInto("_emdash_menus").values({ id, name, label: name }).execute();
			return id;
		}

		it("rejects negative parentIndex", async () => {
			const { handleMenuSetItems } = await import("../../../src/api/handlers/menus.js");
			await setupMenu("main");
			const result = await handleMenuSetItems(db, "main", [
				{ label: "A", type: "custom", customUrl: "/a", parentIndex: -1 },
			]);
			expect(result.success).toBe(false);
			expect(result.error?.code).toBe("VALIDATION_ERROR");
			expect(result.error?.message).toMatch(/parentIndex/);
		});

		it("rejects parentIndex >= current index (forward reference)", async () => {
			const { handleMenuSetItems } = await import("../../../src/api/handlers/menus.js");
			await setupMenu("main");
			const result = await handleMenuSetItems(db, "main", [
				{ label: "A", type: "custom", customUrl: "/a" },
				{ label: "B", type: "custom", customUrl: "/b", parentIndex: 5 },
			]);
			expect(result.success).toBe(false);
			expect(result.error?.code).toBe("VALIDATION_ERROR");
			expect(result.error?.message).toMatch(/parentIndex/);
		});

		it("returns NOT_FOUND for missing menu and leaves unrelated items untouched", async () => {
			const { handleMenuSetItems } = await import("../../../src/api/handlers/menus.js");

			// Seed a real menu with items so the rollback assertion has
			// something to potentially clobber. A regression where the
			// handler deleted ALL items before the existence check (the
			// shape of the bug we want to guard against) would wipe these.
			const otherMenuId = await setupMenu("real");
			const otherItemId = ulid();
			await db
				.insertInto("_emdash_menu_items")
				.values({
					id: otherItemId,
					menu_id: otherMenuId,
					sort_order: 0,
					type: "custom",
					custom_url: "/x",
					label: "X",
				})
				.execute();

			const result = await handleMenuSetItems(db, "ghost", [
				{ label: "A", type: "custom", customUrl: "/a" },
			]);
			expect(result.success).toBe(false);
			expect(result.error?.code).toBe("NOT_FOUND");

			// Unrelated menu's item survives — confirms the transaction
			// rolled back (or never started its destructive phase).
			const items = await db.selectFrom("_emdash_menu_items").selectAll().execute();
			expect(items).toHaveLength(1);
			expect(items[0]?.id).toBe(otherItemId);
			expect(items[0]?.menu_id).toBe(otherMenuId);
		});
	});
});

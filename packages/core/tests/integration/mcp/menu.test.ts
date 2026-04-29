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
): Promise<string> {
	const menuId = ulid();
	const now = new Date().toISOString();
	await db
		.insertInto("_emdash_menus" as never)
		.values({ id: menuId, name, label, created_at: now, updated_at: now } as never)
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
});

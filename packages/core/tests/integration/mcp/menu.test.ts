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
		expect(extractText(result)).toMatch(/not.found|ghost/i);
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
// Bug #15 — gap: no menu mutation tools
// ---------------------------------------------------------------------------

describe("menu tooling gaps (bug #15)", () => {
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

	it("MCP exposes menu_create once the gap is filled", async () => {
		const tools = await harness.client.listTools();
		const names = tools.tools.map((t) => t.name);
		expect(names).toContain("menu_create");
	});

	it("MCP exposes menu_update once the gap is filled", async () => {
		const tools = await harness.client.listTools();
		const names = tools.tools.map((t) => t.name);
		expect(names).toContain("menu_update");
	});

	it("MCP exposes menu_item_create or equivalent once the gap is filled", async () => {
		const tools = await harness.client.listTools();
		const names = new Set(tools.tools.map((t) => t.name));
		const hasItemMutation =
			names.has("menu_item_create") || names.has("menu_add_item") || names.has("menu_set_items");
		expect(hasItemMutation).toBe(true);
	});
});

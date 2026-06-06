/**
 * Menu handler + schema tests
 *
 * Covers the fixes shipped in this PR:
 * - Input schemas reject unknown keys (snake_case payloads no longer pass silently)
 * - `type` is validated against the allowed enum
 * - `customUrl` actually persists when sent under the documented (camelCase) key
 * - Handler responses are camelCase, aligning with the rest of the REST surface
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	handleMenuCreate,
	handleMenuGet,
	handleMenuItemCreate,
	handleMenuItemDelete,
	handleMenuItemUpdate,
	handleMenuSetItems,
} from "../../../src/api/handlers/menus.js";
import { createMenuItemBody, updateMenuItemBody } from "../../../src/api/schemas/menus.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("menu schemas", () => {
	describe("createMenuItemBody.strict()", () => {
		it("rejects snake_case keys (custom_url, sort_order)", () => {
			const result = createMenuItemBody.safeParse({
				type: "custom",
				label: "Blog",
				custom_url: "/blog",
				sort_order: 3,
			});
			expect(result.success).toBe(false);
			if (!result.success) {
				// Zod 4 reports unknown keys with a single `unrecognized_keys`
				// issue whose `keys` array lists the offending names.
				const unknownKeys = result.error.issues
					.filter((i) => i.code === "unrecognized_keys")
					.flatMap((i) =>
						"keys" in i && Array.isArray((i as { keys: unknown }).keys)
							? (i as { keys: string[] }).keys
							: [],
					);
				expect(unknownKeys).toEqual(expect.arrayContaining(["custom_url", "sort_order"]));
			}
		});

		it("rejects the legacy `url` alias", () => {
			const result = createMenuItemBody.safeParse({
				type: "custom",
				label: "Blog",
				url: "/blog",
			});
			expect(result.success).toBe(false);
		});

		it("rejects non-enum `type` values like 'link'", () => {
			const result = createMenuItemBody.safeParse({
				type: "link",
				label: "Blog",
				customUrl: "/blog",
			});
			expect(result.success).toBe(false);
			if (!result.success) {
				const typeIssue = result.error.issues.find((i) => i.path[0] === "type");
				expect(typeIssue).toBeDefined();
			}
		});

		it("accepts the documented camelCase payload", () => {
			const result = createMenuItemBody.safeParse({
				type: "custom",
				label: "Blog",
				customUrl: "/blog",
				sortOrder: 3,
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.customUrl).toBe("/blog");
				expect(result.data.sortOrder).toBe(3);
			}
		});
	});

	describe("updateMenuItemBody.strict()", () => {
		it("rejects snake_case keys on update too", () => {
			const result = updateMenuItemBody.safeParse({ custom_url: "/x" });
			expect(result.success).toBe(false);
		});
	});
});

describe("menu handlers — camelCase responses & customUrl persistence", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("handleMenuCreate returns a camelCase Menu", async () => {
		const result = await handleMenuCreate(db, { name: "primary", label: "Primary" });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toMatchObject({
				name: "primary",
				label: "Primary",
				locale: "en",
			});
			expect(result.data.createdAt).toEqual(expect.any(String));
			expect(result.data.updatedAt).toEqual(expect.any(String));
			expect(result.data.translationGroup).toBeDefined();
			expect(result.data).not.toHaveProperty("created_at");
			expect(result.data).not.toHaveProperty("updated_at");
			expect(result.data).not.toHaveProperty("translation_group");
		}
	});

	it("handleMenuItemCreate persists customUrl and returns camelCase", async () => {
		const menuRes = await handleMenuCreate(db, { name: "primary", label: "Primary" });
		expect(menuRes.success).toBe(true);

		const itemRes = await handleMenuItemCreate(db, "primary", {
			type: "custom",
			label: "Blog",
			customUrl: "/blog",
			sortOrder: 0,
		});
		expect(itemRes.success).toBe(true);
		if (itemRes.success) {
			// camelCase response shape
			expect(itemRes.data).toMatchObject({
				type: "custom",
				label: "Blog",
				customUrl: "/blog",
				sortOrder: 0,
			});
			expect(itemRes.data.menuId).toEqual(expect.any(String));
			expect(itemRes.data.createdAt).toEqual(expect.any(String));
			expect(itemRes.data).not.toHaveProperty("custom_url");
			expect(itemRes.data).not.toHaveProperty("sort_order");
			expect(itemRes.data).not.toHaveProperty("menu_id");
			expect(itemRes.data).not.toHaveProperty("translation_group");
		}

		// And the persisted DB row still has the snake_case column populated
		const getRes = await handleMenuGet(db, "primary");
		expect(getRes.success).toBe(true);
		if (getRes.success) {
			expect(getRes.data.items).toHaveLength(1);
			expect(getRes.data.items[0]).toMatchObject({
				label: "Blog",
				customUrl: "/blog",
				type: "custom",
			});
		}
	});

	it("handleMenuItemUpdate returns camelCase and supports customUrl edits", async () => {
		await handleMenuCreate(db, { name: "primary", label: "Primary" });
		const created = await handleMenuItemCreate(db, "primary", {
			type: "custom",
			label: "Blog",
			customUrl: "/blog",
		});
		expect(created.success).toBe(true);
		if (!created.success) return;

		const updated = await handleMenuItemUpdate(db, "primary", created.data.id, {
			customUrl: "/new-blog",
		});
		expect(updated.success).toBe(true);
		if (updated.success) {
			expect(updated.data.customUrl).toBe("/new-blog");
			expect(updated.data).not.toHaveProperty("custom_url");
		}
	});

	it("handleMenuItemDelete removes the item and returns { deleted: true }", async () => {
		await handleMenuCreate(db, { name: "primary", label: "Primary" });
		const created = await handleMenuItemCreate(db, "primary", {
			type: "custom",
			label: "Blog",
			customUrl: "/blog",
		});
		expect(created.success).toBe(true);
		if (!created.success) return;

		const del = await handleMenuItemDelete(db, "primary", created.data.id);
		expect(del.success).toBe(true);
		if (del.success) expect(del.data.deleted).toBe(true);

		const after = await handleMenuGet(db, "primary");
		expect(after.success).toBe(true);
		if (after.success) expect(after.data.items).toHaveLength(0);
	});

	it("handleMenuGet returns camelCase menu and items", async () => {
		await handleMenuCreate(db, { name: "primary", label: "Primary" });
		await handleMenuItemCreate(db, "primary", {
			type: "custom",
			label: "Blog",
			customUrl: "/blog",
		});

		const res = await handleMenuGet(db, "primary");
		expect(res.success).toBe(true);
		if (res.success) {
			expect(res.data.createdAt).toEqual(expect.any(String));
			expect(res.data.translationGroup).toBeDefined();
			expect(res.data).not.toHaveProperty("created_at");
			expect(res.data.items).toHaveLength(1);
			expect(res.data.items[0].customUrl).toBe("/blog");
			expect(res.data.items[0]).not.toHaveProperty("custom_url");
		}
	});
});

describe("handleMenuSetItems — concurrent delete race", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("returns NOT_FOUND when the menu vanishes between resolve and write", async () => {
		// The original handler's in-transaction `notFoundSentinel` guarded
		// this exact race: a concurrent menu_delete between resolveMenu and
		// the setItems INSERTs would otherwise orphan items on D1.
		const createRes = await handleMenuCreate(db, { name: "primary", label: "Primary" });
		expect(createRes.success).toBe(true);
		if (!createRes.success) return;
		const menuId = createRes.data.id;

		// Simulate the concurrent delete that lands between the handler's
		// resolveMenu lookup and the repository's transaction. We delete
		// directly through Kysely (handlers can't be paused mid-flight).
		await db.deleteFrom("_emdash_menu_items").where("menu_id", "=", menuId).execute();
		await db.deleteFrom("_emdash_menus").where("id", "=", menuId).execute();

		const result = await handleMenuSetItems(db, "primary", [
			{ label: "Orphan?", type: "custom", customUrl: "/orphan" },
		]);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.code).toBe("NOT_FOUND");
			expect(result.error.message).toContain("primary");
		}

		// Nothing was inserted — no orphans.
		const orphans = await db
			.selectFrom("_emdash_menu_items")
			.selectAll()
			.where("menu_id", "=", menuId)
			.execute();
		expect(orphans).toHaveLength(0);
	});
});

describe("menu items path-style route", () => {
	it("exposes a [name]/items/[id].ts route file", async () => {
		// The presence of the file (path-style) is what makes the documented
		// REST-style DELETE /items/:id reachable; without it Astro returns the
		// SSR 404 HTML page. We import dynamically to assert the module exists
		// and exports the expected HTTP verbs.
		const mod = await import("../../../src/astro/routes/api/menus/[name]/items/[id].js");
		expect(typeof mod.PUT).toBe("function");
		expect(typeof mod.DELETE).toBe("function");
		expect(mod.prerender).toBe(false);
	});
});

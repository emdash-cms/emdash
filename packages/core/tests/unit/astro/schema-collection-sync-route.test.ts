import type { Kysely } from "kysely";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { POST as syncCollectionMenuRoute } from "../../../src/astro/routes/api/schema/collections/[slug]/sync-menu.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

	describe("schema collection menu sync route", () => {
	let db: Kysely<Database>;
	let registry: SchemaRegistry;
	let menuIdEn: string;
	let menuIdId: string;

	beforeEach(async () => {
		db = await setupTestDatabase();
		registry = new SchemaRegistry(db);

		await registry.createCollection({ slug: "posts", label: "Posts" });

		menuIdEn = "01HZY00000000000000000000";
		menuIdId = "01HZY00000000000000000001";

		await db
			.insertInto("_emdash_menus")
			.values([
				{ id: menuIdEn, name: "primary", label: "Primary", locale: "en" },
				{ id: menuIdId, name: "primary", label: "Utama", locale: "id" },
			])
			.execute();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("targets the requested menu locale", async () => {
		const request = new Request(
			"http://localhost/_emdash/api/schema/collections/posts/sync-menu?locale=id",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ menuName: "primary" }),
			},
		);

		const response = await syncCollectionMenuRoute({
			params: { slug: "posts" },
			request,
			locals: {
				emdash: { db },
				user: { id: "admin", role: 50 },
			},
		} as Parameters<typeof syncCollectionMenuRoute>[0]);

		expect(response.status).toBe(200);

		const enItems = await db
			.selectFrom("_emdash_menu_items")
			.select(["_emdash_menu_items.label as itemLabel", "_emdash_menu_items.locale"])
			.innerJoin("_emdash_menus", "_emdash_menu_items.menu_id", "_emdash_menus.id")
			.where("_emdash_menus.id", "=", menuIdEn)
			.execute();
		expect(enItems).toHaveLength(0);

		const idItems = await db
			.selectFrom("_emdash_menu_items")
			.select(["_emdash_menu_items.label as itemLabel", "_emdash_menu_items.locale"])
			.innerJoin("_emdash_menus", "_emdash_menu_items.menu_id", "_emdash_menus.id")
			.where("_emdash_menus.id", "=", menuIdId)
			.execute();
		expect(idItems).toHaveLength(1);
		expect(idItems[0]?.locale).toBe("id");
		expect(idItems[0]?.itemLabel).toBe("Posts");
	});
});

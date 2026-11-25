/**
 * Menu read endpoint authorization.
 *
 * menus:read is granted to SUBSCRIBER, but a menu item that links to a content
 * entry carries the entry's collection, id and (as its label) title. Items
 * whose target is not published are gated on content:read_drafts
 * (CONTRIBUTOR+), like the entry itself:
 *
 *   - GET /menus/:name leaves them out for SUBSCRIBER.
 *   - GET /menus leaves them out of `itemCount` for SUBSCRIBER.
 */

import { Role, type RoleLevel } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleMenuCreate, handleMenuItemCreate } from "../../../src/api/handlers/menus.js";
import { GET as getMenu } from "../../../src/astro/routes/api/menus/[name].js";
import { GET as listMenus } from "../../../src/astro/routes/api/menus/index.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

describe("menu read routes — items linking to unpublished content", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		const content = new ContentRepository(db);
		const published = await content.create({
			type: "page",
			slug: "team",
			data: { title: "Our team" },
			status: "published",
		});
		const draft = await content.create({
			type: "page",
			slug: "acme",
			data: { title: "We are acquiring Acme Corp" },
		});
		await handleMenuCreate(db, { name: "primary", label: "Primary" });
		for (const entry of [published, draft]) {
			await handleMenuItemCreate(db, "primary", {
				type: "page",
				label: String(entry.data.title),
				referenceCollection: "page",
				referenceId: entry.id,
			});
		}
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	async function readMenu(role: RoleLevel) {
		const context = {
			params: { name: "primary" },
			request: new Request("http://localhost/_emdash/api/menus/primary"),
			locals: { emdash: { db }, user: { id: "user-1", role } },
		};
		const menu = await getMenu(context as unknown as Parameters<typeof getMenu>[0]);
		const list = await listMenus({
			...context,
			params: {},
			request: new Request("http://localhost/_emdash/api/menus"),
		} as unknown as Parameters<typeof listMenus>[0]);
		expect(menu.status).toBe(200);
		expect(list.status).toBe(200);
		const menuBody = (await menu.json()) as { data: { items: Array<{ label: string }> } };
		const listBody = (await list.json()) as { data: Array<{ name: string; itemCount: number }> };
		return {
			labels: menuBody.data.items.map((item) => item.label),
			itemCount: listBody.data.find((entry) => entry.name === "primary")?.itemCount,
		};
	}

	it("hides them from a SUBSCRIBER", async () => {
		expect(await readMenu(Role.SUBSCRIBER)).toEqual({ labels: ["Our team"], itemCount: 1 });
	});

	it("returns them to a CONTRIBUTOR", async () => {
		expect(await readMenu(Role.CONTRIBUTOR)).toEqual({
			labels: ["Our team", "We are acquiring Acme Corp"],
			itemCount: 2,
		});
	});
});

/**
 * Dev-bypass seed gating.
 *
 * The route seeds sample data by default; `?content=0` (or `false`) applies
 * schema/structure only so an agent or test harness can start from a clean
 * site without deleting seeded entries afterwards.
 */

import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import type { SeedFile } from "../../../src/seed/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const fixtureSeed: SeedFile = {
	version: "1",
	settings: { title: "Fixture Site" },
	collections: [
		{
			slug: "posts",
			label: "Posts",
			fields: [{ slug: "title", label: "Title", type: "string" }],
		},
	],
	taxonomies: [
		{
			name: "tags",
			label: "Tags",
			hierarchical: false,
			collections: ["posts"],
			terms: [{ slug: "sample-tag", label: "Sample Tag" }],
		},
	],
	bylines: [{ id: "sample", slug: "sample-author", displayName: "Sample Author" }],
	content: {
		posts: [{ id: "post-1", slug: "sample-post", data: { title: "Sample Post" } }],
	},
	menus: [
		{
			name: "primary",
			label: "Primary",
			items: [{ type: "custom", label: "Home", url: "/" }],
		},
	],
};

vi.mock("virtual:emdash/seed", () => ({ seed: fixtureSeed, userSeed: null }), { virtual: true });

import { GET } from "../../../src/astro/routes/api/setup/dev-bypass.js";

function makeContext(db: Kysely<Database>, search = ""): APIContext {
	return {
		locals: { emdash: { db, storage: null, config: {} } },
		url: new URL(`http://localhost:4321/_emdash/api/setup/dev-bypass${search}`),
		session: undefined,
	} as unknown as APIContext;
}

async function countPosts(db: Kysely<Database>) {
	const { items } = await new ContentRepository(db).findMany("posts", {});
	return items.length;
}

async function countRows(db: Kysely<Database>, table: "taxonomies" | "_emdash_bylines") {
	const rows = await db.selectFrom(table).select("id").execute();
	return rows.length;
}

describe("setup dev-bypass seed gating", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("seeds sample data by default", async () => {
		const response = await GET(makeContext(db));
		expect(response.status).toBe(200);

		expect(await countPosts(db)).toBe(1);
		expect(await countRows(db, "taxonomies")).toBe(1);
		expect(await countRows(db, "_emdash_bylines")).toBe(1);
	});

	it("applies schema only with ?content=0", async () => {
		const response = await GET(makeContext(db, "?content=0"));
		expect(response.status).toBe(200);

		expect(await countPosts(db)).toBe(0);
		expect(await countRows(db, "taxonomies")).toBe(0);
		expect(await countRows(db, "_emdash_bylines")).toBe(0);

		// Schema and structure still apply
		const collections = await db
			.selectFrom("_emdash_collections")
			.select("slug")
			.where("slug", "=", "posts")
			.execute();
		expect(collections).toHaveLength(1);

		const taxonomyDefs = await db
			.selectFrom("_emdash_taxonomy_defs")
			.select("name")
			.where("name", "=", "tags")
			.execute();
		expect(taxonomyDefs).toHaveLength(1);

		const menus = await db
			.selectFrom("_emdash_menus")
			.select("name")
			.where("name", "=", "primary")
			.execute();
		expect(menus).toHaveLength(1);
	});

	it("accepts ?content=false", async () => {
		const response = await GET(makeContext(db, "?content=false"));
		expect(response.status).toBe(200);

		expect(await countPosts(db)).toBe(0);
	});
});

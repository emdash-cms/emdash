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
			fields: [
				{ slug: "title", label: "Title", type: "string" },
				{ slug: "featured_image", label: "Featured image", type: "image" },
			],
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
		posts: [
			{
				id: "post-1",
				slug: "sample-post",
				data: {
					title: "Sample Post",
					featured_image: {
						id: "seed-media-1",
						provider: "local",
						filename: "sample.jpg",
						mimeType: "image/jpeg",
					},
				},
			},
		],
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

import { GET as AUTH_GET } from "../../../src/astro/routes/api/auth/dev-bypass.js";
import { GET } from "../../../src/astro/routes/api/setup/dev-bypass.js";
import { POST as SETUP_POST } from "../../../src/astro/routes/api/setup/index.js";
import { MIGRATION_NAMES } from "../../../src/database/migrations/runner.js";

function makeContext(db: Kysely<Database>, search = ""): APIContext {
	return {
		locals: { emdash: { db, storage: null, config: {} } },
		url: new URL(`http://localhost:4321/_emdash/api/setup/dev-bypass${search}`),
		session: undefined,
	} as unknown as APIContext;
}

function makeSetupContext(db: Kysely<Database>): APIContext {
	const url = new URL("http://localhost:4321/_emdash/api/setup");
	return {
		locals: { emdash: { db, storage: null, config: { migrations: { runtime: "manual" } } } },
		url,
		request: new Request(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Manual Site", tagline: "", includeContent: false }),
		}),
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

	it("makes seeded media usage ready without activating incremental capture", async () => {
		const response = await GET(makeContext(db));
		expect(response.status).toBe(200);

		const usage = await db
			.selectFrom("_emdash_media_usage")
			.select(["media_id", "field_slug"])
			.where("media_id", "=", "seed-media-1")
			.execute();
		expect(usage).toEqual([{ media_id: "seed-media-1", field_slug: "featured_image" }]);

		const coverage = await db
			.selectFrom("_emdash_media_usage_index_status")
			.select(["status", "indexed_source_count"])
			.where("adapter_id", "=", "content-media")
			.where("scope_type", "=", "collection")
			.where("scope_key", "=", "posts")
			.executeTakeFirstOrThrow();
		expect(coverage).toEqual({ status: "complete", indexed_source_count: 1 });

		const activation = await db
			.selectFrom("_emdash_media_usage_activation")
			.select("state")
			.where("task_key", "=", "incremental_capture")
			.executeTakeFirstOrThrow();
		expect(activation.state).toBe("expanded");
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

	it.each([
		["setup dev bypass", (database: Kysely<Database>) => GET(makeContext(database, "?content=0"))],
		["auth dev bypass", (database: Kysely<Database>) => AUTH_GET(makeContext(database))],
		["setup wizard", (database: Kysely<Database>) => SETUP_POST(makeSetupContext(database))],
	])("does not migrate from the %s route", async (_name, invoke) => {
		const pending = MIGRATION_NAMES.at(-1)!;
		await db.deleteFrom("_emdash_migrations").where("name", "=", pending).execute();

		const response = await invoke(db);

		expect(response.status).toBe(200);
		const record = await db
			.selectFrom("_emdash_migrations")
			.select("name")
			.where("name", "=", pending)
			.executeTakeFirst();
		expect(record).toBeUndefined();
	});
});

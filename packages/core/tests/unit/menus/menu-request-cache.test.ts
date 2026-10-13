import { Kysely, SqliteDialect } from "kysely";
import { ulid } from "ulidx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteCompatDatabase as Database } from "#node-sqlite";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database as DatabaseSchema } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";

vi.mock("virtual:emdash/wait-until", () => ({ waitUntil: undefined }), { virtual: true });

// Mock loader.getDb so the runtime menu functions read from our test db.
vi.mock("../../../src/loader.js", () => ({
	getDb: vi.fn(),
}));

import { prefetchLayoutData } from "../../../src/astro/prefetch.js";
import { MenuRepository } from "../../../src/database/repositories/menu.js";
import { getDb } from "../../../src/loader.js";
import { getMenu } from "../../../src/menus/index.js";
import { __setObjectCacheBackendForTests } from "../../../src/object-cache/index.js";
import { runWithContext } from "../../../src/request-context.js";

/** SQL of every query executed against the test database. */
let queries: string[] = [];

function collectionPatternQueries(): string[] {
	return queries.filter((q) => q.includes("_emdash_collections") && q.includes("url_pattern"));
}

describe("getMenu collection-pattern request cache", () => {
	let db: Kysely<DatabaseSchema>;

	beforeEach(async () => {
		queries = [];
		db = new Kysely<DatabaseSchema>({
			dialect: new SqliteDialect({ database: new Database(":memory:") }),
			log(event) {
				if (event.level === "query") queries.push(event.query.sql);
			},
		});
		await runMigrations(db);

		// A "post" collection with a url_pattern, plus one published entry
		// that menu items can reference.
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "post",
			label: "Posts",
			labelSingular: "Post",
		});
		await db
			.updateTable("_emdash_collections")
			.set({ url_pattern: "/blog/{slug}" })
			.where("slug", "=", "post")
			.execute();

		const entryId = ulid();
		await db
			.insertInto("ec_post" as never)
			.values({
				id: entryId,
				slug: "hello",
				status: "published",
				locale: "en",
				translation_group: entryId,
			} as never)
			.execute();

		// Two menus that both reference the same collection.
		for (const name of ["primary", "footer"]) {
			const menuId = ulid();
			await db.insertInto("_emdash_menus").values({ id: menuId, name, label: name }).execute();
			await db
				.insertInto("_emdash_menu_items")
				.values({
					id: ulid(),
					menu_id: menuId,
					sort_order: 0,
					type: "post",
					reference_collection: "post",
					reference_id: entryId,
					label: "Hello",
				})
				.execute();
		}

		vi.mocked(getDb).mockResolvedValue(db);
	});

	afterEach(async () => {
		await db.destroy();
		vi.restoreAllMocks();
	});

	it("queries collection url_patterns once for multiple menus in one request", async () => {
		queries = [];

		const [primary, footer] = await runWithContext({ editMode: false }, async () => {
			const first = await getMenu("primary");
			const second = await getMenu("footer");
			return [first, second];
		});

		expect(primary?.items.map((i) => i.url)).toEqual(["/blog/hello"]);
		expect(footer?.items.map((i) => i.url)).toEqual(["/blog/hello"]);

		expect(collectionPatternQueries()).toHaveLength(1);
	});

	it("returns identical results with and without a request context", async () => {
		const cached = await runWithContext({ editMode: false }, () => getMenu("primary"));
		const uncached = await getMenu("primary");

		expect(cached).toEqual(uncached);
	});

	it("does not leak the cached patterns across requests", async () => {
		await runWithContext({ editMode: false }, () => getMenu("primary"));
		queries = [];

		await runWithContext({ editMode: false }, () => getMenu("footer"));

		expect(collectionPatternQueries()).toHaveLength(1);
	});

	it("prefetchLayoutData warms menus so layout getMenu calls hit the cache", async () => {
		await runWithContext({ editMode: false }, async () => {
			// Eager prefetch discovers every menu name and warms them up front.
			await prefetchLayoutData();

			// Anything the layout reads afterwards must be served from the
			// request cache the prefetch populated -- zero further queries.
			queries = [];
			const primary = await getMenu("primary");
			const footer = await getMenu("footer");

			expect(primary?.items.map((i) => i.url)).toEqual(["/blog/hello"]);
			expect(footer?.items.map((i) => i.url)).toEqual(["/blog/hello"]);
			expect(queries).toHaveLength(0);
		});
	});

	describe("with an object cache backend", () => {
		beforeEach(() => {
			const store = new Map<string, string>();
			__setObjectCacheBackendForTests(
				{
					get: (k) => Promise.resolve(store.get(k) ?? null),
					set: (k, v) => {
						store.set(k, v);
						return Promise.resolve();
					},
					delete: (k) => {
						store.delete(k);
						return Promise.resolve();
					},
				},
				{ revalidate: 60_000, defaultTtl: 3600 },
			);
		});

		afterEach(() => {
			__setObjectCacheBackendForTests(null);
		});

		const menuNameQueries = () =>
			queries.filter((q) => q.includes('"_emdash_menus"') && q.includes("distinct"));

		it("serves discovered menu names from the object cache until a menu is created", async () => {
			const prefetch = () => runWithContext({ editMode: false, db }, () => prefetchLayoutData());

			await prefetch();
			await flush();
			queries = [];
			await prefetch();
			expect(menuNameQueries()).toHaveLength(0);

			await new MenuRepository(db).create({ name: "social", label: "Social" });
			await flush();
			queries = [];
			await prefetch();
			expect(menuNameQueries()).toHaveLength(1);
		});
	});
});

async function flush(): Promise<void> {
	await new Promise((r) => setTimeout(r, 0));
}

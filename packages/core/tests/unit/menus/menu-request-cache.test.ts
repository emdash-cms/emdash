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
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { MenuRepository } from "../../../src/database/repositories/menu.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import { getDb } from "../../../src/loader.js";
import { getMenu } from "../../../src/menus/index.js";
import {
	__setObjectCacheBackendForTests,
	invalidateMenuObjectCache,
} from "../../../src/object-cache/index.js";
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
		expect(queries.filter((q) => q.includes('"_emdash_menu_items"'))).toHaveLength(2);
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
		let backendReads = 0;
		let onRowsRead: (() => Promise<void>) | undefined;

		beforeEach(() => {
			const store = new Map<string, string>();
			__setObjectCacheBackendForTests(
				{
					get: async (k) => {
						backendReads++;
						const value = store.get(k) ?? null;
						if (k.includes(":rows:") && onRowsRead) {
							const hook = onRowsRead;
							onRowsRead = undefined;
							await hook();
						}
						return value;
					},
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

		async function insertMenuLinking(
			name: string,
			item: { type: string; reference_collection?: string; reference_id: string },
		): Promise<void> {
			const menuId = ulid();
			await db.insertInto("_emdash_menus").values({ id: menuId, name, label: name }).execute();
			await db
				.insertInto("_emdash_menu_items")
				.values({ id: ulid(), menu_id: menuId, sort_order: 0, label: name, ...item })
				.execute();
		}

		/** Menu URLs in a fresh request, after checking a repeat read is served from the cache. */
		async function cachedMenuUrls(name: string): Promise<string[] | undefined> {
			const read = () => runWithContext({ editMode: false, db }, () => getMenu(name));
			const menu = await read();
			await flush();
			queries = [];
			expect(await read()).toEqual(menu);
			expect(queries).toHaveLength(0);
			return menu?.items.map((item) => item.url);
		}

		it("returns null for a menu that does not exist", async () => {
			expect(await cachedMenuUrls("missing")).toBeUndefined();
		});

		it("keeps cached menus apart by locale and trailing-slash policy", async () => {
			await db
				.insertInto("_emdash_menus")
				.values({ id: ulid(), name: "primary", label: "Hauptmenü", locale: "de" })
				.execute();
			const read = (options: { locale: string; trailingSlash: "always" | "never" }) =>
				runWithContext({ editMode: false, db }, () => getMenu("primary", options));

			const always = await read({ locale: "en", trailingSlash: "always" });
			await flush();
			const never = await read({ locale: "en", trailingSlash: "never" });
			const german = await read({ locale: "de", trailingSlash: "never" });

			expect(always?.items.map((item) => item.url)).toEqual(["/blog/hello/"]);
			expect(never?.items.map((item) => item.url)).toEqual(["/blog/hello"]);
			expect(german?.label).toBe("Hauptmenü");
		});

		it("refreshes a cached menu when a linked entry is published or trashed", async () => {
			const repo = new ContentRepository(db);
			const entry = await repo.create({ type: "post", slug: "launch", data: {} });
			await insertMenuLinking("header", {
				type: "post",
				reference_collection: "post",
				reference_id: entry.id,
			});
			expect(await cachedMenuUrls("header")).toEqual([]);

			await repo.publish("post", entry.id);
			expect(await cachedMenuUrls("header")).toEqual(["/blog/launch"]);

			await repo.delete("post", entry.id);
			expect(await cachedMenuUrls("header")).toEqual([]);
		});

		it("reads the cache once for a warm menu, also after its links change", async () => {
			const urls = async () =>
				(await runWithContext({ editMode: false, db }, () => getMenu("primary")))?.items.map(
					(item) => item.url,
				);
			const warmReads = async () => {
				await flush();
				backendReads = 0;
				const warm = await urls();
				expect(backendReads).toBe(1);
				return warm;
			};

			await urls();
			expect(await warmReads()).toEqual(["/blog/hello"]);

			await new SchemaRegistry(db).createCollection({
				slug: "page",
				label: "Pages",
				labelSingular: "Page",
			});
			const pages = new ContentRepository(db);
			const about = await pages.create({ type: "page", slug: "about", data: {} });
			await pages.publish("page", about.id);
			const menus = new MenuRepository(db);
			const [primary] = await menus.findByName("primary");
			await menus.createItem(primary!.id, primary!.locale, {
				type: "page",
				label: "About",
				referenceCollection: "page",
				referenceId: about.id,
			});
			expect(await urls()).toEqual(["/blog/hello", "/page/about"]);
			await urls();
			expect(await warmReads()).toEqual(["/blog/hello", "/page/about"]);

			await pages.delete("page", about.id);
			expect(await urls()).toEqual(["/blog/hello"]);
		});

		/** The per-isolate memo of the namespaces each menu was last resolved under. */
		function namespacesMemo(): Map<string, string[]> {
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the per-isolate memo
			return (globalThis as Record<symbol, unknown>)[
				Symbol.for("emdash:menu-resolved-namespaces")
			] as Map<string, string[]>;
		}

		it.each([
			["a render", false],
			["a fresh isolate", true],
		])("keeps a menu edit that lands while %s reads the menu rows", async (_, freshIsolate) => {
			const labels = async () =>
				(await runWithContext({ editMode: false, db }, () => getMenu("primary")))?.items.map(
					(item) => item.label,
				);
			await labels();
			await flush();
			await new ContentRepository(db).create({ type: "post", slug: "other", data: {} });
			if (freshIsolate) namespacesMemo().clear();
			onRowsRead = async () => {
				await db.updateTable("_emdash_menu_items").set({ label: "Renamed" }).execute();
				invalidateMenuObjectCache();
			};

			await labels();
			await flush();

			expect(onRowsRead).toBeUndefined();
			expect(await labels()).toEqual(["Renamed"]);
		});

		it("never caches a menu under namespaces its links no longer match", async () => {
			const urls = async () =>
				(await runWithContext({ editMode: false, db }, () => getMenu("primary")))?.items.map(
					(item) => item.url,
				);
			await urls();
			const memo = namespacesMemo();
			const [memoKey, before] = [...memo].find(([key]) => key.startsWith("primary:"))!;
			// Another isolate still knows the menu by the namespaces it had before the edit.
			const asOtherIsolate = () => memo.set(memoKey, before);

			await new SchemaRegistry(db).createCollection({
				slug: "page",
				label: "Pages",
				labelSingular: "Page",
			});
			const pages = new ContentRepository(db);
			const about = await pages.create({ type: "page", slug: "about", data: {} });
			await pages.publish("page", about.id);
			const menus = new MenuRepository(db);
			const [primary] = await menus.findByName("primary");
			await menus.createItem(primary!.id, primary!.locale, {
				type: "page",
				label: "About",
				referenceCollection: "page",
				referenceId: about.id,
			});
			expect(await urls()).toEqual(["/blog/hello", "/page/about"]);
			await flush();

			await pages.delete("page", about.id);
			asOtherIsolate();
			expect(await urls()).toEqual(["/blog/hello"]);
		});

		it("returns null for a cached menu once it is deleted", async () => {
			const read = () => runWithContext({ editMode: false, db }, () => getMenu("primary"));
			expect(await read()).not.toBeNull();
			await flush();

			const menus = new MenuRepository(db);
			const [primary] = await menus.findByName("primary");
			await menus.delete(primary!.id);

			expect(await read()).toBeNull();
		});

		it("refreshes a cached menu when a linked term changes", async () => {
			const repo = new TaxonomyRepository(db);
			const term = await repo.create({ name: "category", slug: "news", label: "News" });
			await insertMenuLinking("topics", { type: "taxonomy", reference_id: term.id });
			expect(await cachedMenuUrls("topics")).toEqual(["/category/news"]);

			await repo.update(term.id, { slug: "updates" });
			expect(await cachedMenuUrls("topics")).toEqual(["/category/updates"]);
		});
	});
});

async function flush(): Promise<void> {
	await new Promise((r) => setTimeout(r, 0));
}

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { _resetAstroI18nCacheForTests } from "../../../src/i18n/resolve.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { FTSManager } from "../../../src/search/fts-manager.js";
import { getSuggestions, searchCollection, searchWithDb } from "../../../src/search/query.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const hostConfig = vi.hoisted(() => ({ trailingSlash: "ignore" }));
vi.mock("virtual:emdash/config", () => ({ default: hostConfig }));

describe("search result URLs", () => {
	let db: Kysely<Database>;
	let repo: ContentRepository;
	let registry: SchemaRegistry;

	beforeEach(async () => {
		db = await setupTestDatabase();
		repo = new ContentRepository(db);
		registry = new SchemaRegistry(db);
		const fts = new FTSManager(db);

		await registry.createCollection({
			slug: "pages",
			label: "Pages",
			urlPattern: "/{slug}",
			supports: ["search"],
		});
		await registry.createCollection({
			slug: "posts",
			label: "Posts",
			urlPattern: "/blog/{slug}",
			supports: ["search"],
		});
		for (const collection of ["pages", "posts"]) {
			await registry.createField(collection, {
				slug: "title",
				label: "Title",
				type: "string",
				searchable: true,
			});
		}
		await fts.enableSearch("pages");
		await fts.enableSearch("posts");
	});

	afterEach(async () => {
		hostConfig.trailingSlash = "ignore";
		setI18nConfig(null);
		_resetAstroI18nCacheForTests();
		await teardownTestDatabase(db);
	});

	const searchers = [
		{
			name: "searchWithDb",
			search: (database: Kysely<Database>, collection: string, query: string) =>
				searchWithDb(database, query, { collections: [collection] }).then(
					(response) => response.items,
				),
		},
		{
			name: "searchCollection",
			search: (database: Kysely<Database>, collection: string, query: string) =>
				searchCollection(database, collection, query).then((response) => response.items),
		},
		{
			name: "getSuggestions",
			search: (database: Kysely<Database>, collection: string, query: string) =>
				getSuggestions(database, query, { collections: [collection] }),
		},
	];

	it.each(searchers)("resolves URL patterns for $name", async ({ search }) => {
		await repo.create({
			type: "pages",
			slug: "my page",
			status: "published",
			data: { title: "Root page" },
		});
		await repo.create({
			type: "posts",
			slug: "news",
			status: "published",
			data: { title: "Blog news" },
		});

		const page = (await search(db, "pages", "Root"))[0];
		const post = (await search(db, "posts", "Blog"))[0];
		expect(page.url).toBe("/my%20page");
		expect(post.url).toBe("/blog/news");
	});

	it.each(searchers)("uses published date and id tokens in $name", async ({ search }) => {
		const entry = await repo.create({
			type: "posts",
			slug: null,
			status: "published",
			data: { title: "Dated entry" },
		});
		await db
			.updateTable("ec_posts")
			.set({ published_at: "2024-03-05T12:00:00.000Z" })
			.where("id", "=", entry.id)
			.execute();
		await registry.updateCollection("posts", { urlPattern: "/{year}/{month}/{day}/{id}" });

		const result = (await search(db, "posts", "Dated"))[0];
		expect(result.url).toBe(`/2024/03/05/${entry.id}`);
	});

	it.each(searchers)(
		"falls back and reflects pattern updates without rebuilding in $name",
		async ({ search }) => {
			await registry.updateCollection("pages", { urlPattern: null });
			await repo.create({
				type: "pages",
				slug: "plain",
				status: "published",
				data: { title: "Plain page" },
			});
			const first = (await search(db, "pages", "Plain"))[0];
			expect(first.url).toBe("/pages/plain");

			await registry.updateCollection("pages", { urlPattern: "/new/{slug}" });
			const second = (await search(db, "pages", "Plain"))[0];
			expect(second.url).toBe("/new/plain");
		},
	);

	it.each(searchers)("uses the id when the slug is missing in $name", async ({ search }) => {
		const entry = await repo.create({
			type: "pages",
			slug: "temporary",
			status: "published",
			data: { title: "Missing slug" },
		});
		await db.updateTable("ec_pages").set({ slug: null }).where("id", "=", entry.id).execute();
		expect((await search(db, "pages", "Missing"))[0].url).toBe(`/${entry.id}`);
	});

	it.each(searchers)("honors trailing slashes in $name", async ({ search }) => {
		hostConfig.trailingSlash = "always";
		await repo.create({
			type: "pages",
			slug: "my-page",
			status: "published",
			data: { title: "Trailing slash" },
		});
		expect((await search(db, "pages", "Trailing"))[0].url).toBe("/my-page/");
	});

	it.each(searchers)("prefixes localized results in $name", async ({ search }) => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"], prefixDefaultLocale: true });
		_resetAstroI18nCacheForTests();
		await repo.create({
			type: "pages",
			slug: "bonjour",
			locale: "fr",
			status: "published",
			data: { title: "Bonjour page" },
		});

		const result = (await search(db, "pages", "Bonjour"))[0];
		expect(result.url).toBe("/fr/bonjour");
	});
});

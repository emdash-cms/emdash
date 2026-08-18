import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { FTSManager } from "../../../src/search/fts-manager.js";
import { getSuggestions, searchWithDb } from "../../../src/search/query.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

/**
 * Regression test for #1178.
 *
 * `title` is an optional user-defined field, not a system column on `ec_*`
 * tables. Searching across all collections (no `collections` filter) walked
 * every search-enabled collection, and the search SQL referenced `c.title`
 * unconditionally. Any collection without a `title` field made the query throw
 * `D1_ERROR: no such column: c.title`, which propagated and failed the whole
 * call. Scoping the search to collections that happen to have a title masked
 * the bug -- only the "search everything" path tripped it.
 */
describe("search: collection without a title field (#1178)", () => {
	let db: Kysely<Database>;
	let repo: ContentRepository;

	beforeEach(async () => {
		db = await setupTestDatabase();
		repo = new ContentRepository(db);

		const registry = new SchemaRegistry(db);
		const fts = new FTSManager(db);

		// Collection WITH a title field (the typical case).
		await registry.createCollection({ slug: "post", label: "Posts", supports: ["search"] });
		await registry.createField("post", {
			slug: "title",
			label: "Title",
			type: "string",
			searchable: true,
		});
		await registry.createField("post", {
			slug: "body",
			label: "Body",
			type: "text",
			searchable: true,
		});
		await fts.enableSearch("post");

		// Collection WITHOUT a title field -- only a searchable "body".
		await registry.createCollection({ slug: "note", label: "Notes", supports: ["search"] });
		await registry.createField("note", {
			slug: "body",
			label: "Body",
			type: "text",
			searchable: true,
		});
		await fts.enableSearch("note");

		await repo.create({
			type: "post",
			slug: "p1",
			status: "published",
			data: { title: "Widget guide", body: "All about widgets" },
		});
		await repo.create({
			type: "note",
			slug: "n1",
			status: "published",
			data: { body: "A note about widgets" },
		});
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("searches across all collections when one lacks a title field", async () => {
		const res = await searchWithDb(db, "widget");

		const collections = res.items.map((i) => i.collection);
		expect(collections).toContain("post");
		expect(collections).toContain("note");

		// The title-less collection still returns a result; its title is simply
		// absent (SearchResult.title is optional), and the slug is preserved.
		const note = res.items.find((i) => i.collection === "note");
		expect(note?.title).toBeUndefined();
		expect(note?.slug).toBe("n1");
	});

	it("returns suggestions across all collections, skipping ones without a title", async () => {
		const suggestions = await getSuggestions(db, "widget");

		// The collection with a title is suggested...
		expect(suggestions.some((s) => s.collection === "post")).toBe(true);
		// ...and the title-less collection is silently skipped rather than
		// throwing (a suggestion requires a title, which it cannot provide).
		expect(suggestions.every((s) => s.collection !== "note")).toBe(true);
	});

	it("bulk-resolves title-column membership for a mixed set of collections in one query", async () => {
		const fts = new FTSManager(db);
		const withTitle = await fts.getCollectionsWithTitleColumn(["post", "note"]);

		expect(withTitle.has("post")).toBe(true);
		expect(withTitle.has("note")).toBe(false);
	});
});

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { FTSManager } from "../../../src/search/fts-manager.js";
import { getSuggestions, searchCollection, searchWithDb } from "../../../src/search/query.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("search query counts", () => {
	let db: Kysely<Database>;
	let repo: ContentRepository;
	let fts: FTSManager;

	beforeEach(async () => {
		db = await setupTestDatabase();
		repo = new ContentRepository(db);
		fts = new FTSManager(db);

		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "articles", label: "Articles", supports: ["search"] });
		await registry.createField("articles", {
			slug: "body",
			label: "Body",
			type: "text",
			searchable: true,
		});
		await registry.createField("articles", {
			slug: "title",
			label: "Title",
			type: "string",
			searchable: true,
		});
		await fts.enableSearch("articles", { weights: { title: 10, body: 1 } });
		await repo.create({
			type: "articles",
			slug: "title-match",
			status: "published",
			data: { title: "Farrier handbook", body: "Stable work" },
		});
		await repo.create({
			type: "articles",
			slug: "body-match",
			status: "published",
			data: { title: "Stable handbook", body: "A farrier explains the work" },
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await teardownTestDatabase(db);
	});

	it("uses one metadata query and one match for matching and empty results", async () => {
		const executeQuery = vi.spyOn(db.getExecutor(), "executeQuery");

		executeQuery.mockClear();
		const matching = await searchWithDb(db, "farrier", { collections: ["articles"] });
		expect(executeQuery).toHaveBeenCalledTimes(2);
		expect(matching.items.map((item) => item.slug)).toEqual(["title-match", "body-match"]);
		expect(matching.items[0]?.title).toBe("Farrier handbook");
		expect(matching.items[1]?.snippet).toContain("<mark>farrier</mark>");

		executeQuery.mockClear();
		const empty = await searchWithDb(db, "does-not-exist", { collections: ["articles"] });
		expect(executeQuery).toHaveBeenCalledTimes(2);
		expect(empty.items).toEqual([]);
	});

	it("discovers and explicitly searches only enabled collections with FTS tables", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "notes", label: "Notes", supports: ["search"] });
		await registry.createField("notes", {
			slug: "body",
			label: "Body",
			type: "text",
			searchable: true,
		});
		await fts.enableSearch("notes");
		await repo.create({
			type: "notes",
			slug: "note-match",
			status: "published",
			data: { body: "A farrier note" },
		});

		await registry.createCollection({ slug: "disabled", label: "Disabled", supports: ["search"] });
		await registry.createField("disabled", {
			slug: "body",
			label: "Body",
			type: "text",
			searchable: true,
		});
		await fts.enableSearch("disabled");
		await fts.setSearchConfig("disabled", { enabled: false });

		await registry.createCollection({ slug: "missing", label: "Missing", supports: ["search"] });
		await registry.createField("missing", {
			slug: "body",
			label: "Body",
			type: "text",
			searchable: true,
		});
		await fts.enableSearch("missing");
		await fts.dropFtsTable("missing");

		const executeQuery = vi.spyOn(db.getExecutor(), "executeQuery");
		executeQuery.mockClear();
		const discovered = await searchWithDb(db, "farrier");
		expect(executeQuery).toHaveBeenCalledTimes(3);
		expect(
			discovered.items
				.map((item) => item.slug)
				.toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
		).toEqual(["body-match", "note-match", "title-match"]);
		expect(discovered.items.find((item) => item.collection === "notes")?.title).toBeUndefined();

		executeQuery.mockClear();
		const explicit = await searchWithDb(db, "farrier", {
			collections: ["articles", "notes", "disabled", "missing", "not-a-collection"],
		});
		expect(executeQuery).toHaveBeenCalledTimes(3);
		expect(explicit.items).toEqual(discovered.items);
	});

	it("counts searchCollection and skips whitespace-only searches", async () => {
		const executeQuery = vi.spyOn(db.getExecutor(), "executeQuery");

		executeQuery.mockClear();
		const result = await searchCollection(db, "articles", "farrier");
		expect(executeQuery).toHaveBeenCalledTimes(2);
		expect(result.items.map((item) => item.slug)).toEqual(["title-match", "body-match"]);

		executeQuery.mockClear();
		expect((await searchWithDb(db, "   ", { collections: ["articles"] })).items).toEqual([]);
		expect(executeQuery).toHaveBeenCalledTimes(0);

		executeQuery.mockClear();
		expect((await searchCollection(db, "articles", "\t\n")).items).toEqual([]);
		expect(executeQuery).toHaveBeenCalledTimes(0);
	});

	it("counts autocomplete matches and skips blank queries", async () => {
		const executeQuery = vi.spyOn(db.getExecutor(), "executeQuery");

		executeQuery.mockClear();
		const matching = await getSuggestions(db, "far", { collections: ["articles"] });
		expect(executeQuery).toHaveBeenCalledTimes(2);
		expect(
			matching
				.map((suggestion) => suggestion.slug)
				.toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
		).toEqual(["body-match", "title-match"]);
		expect(matching.map((suggestion) => suggestion.title)).toEqual(
			expect.arrayContaining(["Farrier handbook", "Stable handbook"]),
		);

		executeQuery.mockClear();
		const empty = await getSuggestions(db, "does-not-exist", { collections: ["articles"] });
		expect(executeQuery).toHaveBeenCalledTimes(2);
		expect(empty).toEqual([]);

		for (const query of ["", " \t\n"]) {
			executeQuery.mockClear();
			expect(await getSuggestions(db, query, { collections: ["articles"] })).toEqual([]);
			expect(executeQuery).toHaveBeenCalledTimes(0);
		}
	});

	it("uses one metadata query for multi-collection autocomplete", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "employees",
			label: "Employees",
			supports: ["search"],
		});
		await registry.createField("employees", {
			slug: "name",
			label: "Name",
			type: "text",
			searchable: true,
		});
		await registry.updateCollection("employees", { titleField: "name" });
		await fts.enableSearch("employees");
		await repo.create({
			type: "employees",
			slug: "farrier-amy",
			status: "published",
			data: { name: "Farrier Amy" },
		});

		await registry.createCollection({ slug: "notes", label: "Notes", supports: ["search"] });
		await registry.createField("notes", {
			slug: "body",
			label: "Body",
			type: "text",
			searchable: true,
		});
		await fts.enableSearch("notes");

		await registry.createCollection({ slug: "missing", label: "Missing", supports: ["search"] });
		await registry.createField("missing", {
			slug: "title",
			label: "Title",
			type: "text",
			searchable: true,
		});
		await fts.enableSearch("missing");
		await fts.dropFtsTable("missing");

		await registry.createCollection({ slug: "disabled", label: "Disabled", supports: ["search"] });
		await registry.createField("disabled", {
			slug: "title",
			label: "Title",
			type: "text",
			searchable: true,
		});
		await fts.enableSearch("disabled");
		await fts.setSearchConfig("disabled", { enabled: false });

		const executeQuery = vi.spyOn(db.getExecutor(), "executeQuery");
		const requested = ["employees", "articles", "notes", "missing", "disabled", "unknown"];

		executeQuery.mockClear();
		const explicit = await getSuggestions(db, "far", { collections: requested, limit: 1 });
		expect(executeQuery).toHaveBeenCalledTimes(3);
		expect(explicit).toHaveLength(1);
		expect(explicit[0]?.collection).toBe("employees");
		expect(explicit[0]?.title).toBe("Farrier Amy");

		executeQuery.mockClear();
		const discovered = await getSuggestions(db, "far", { collections: [] });
		expect(executeQuery).toHaveBeenCalledTimes(3);
		expect(discovered.map((suggestion) => suggestion.collection)).toEqual([
			"articles",
			"articles",
			"employees",
		]);
		expect(discovered.map((suggestion) => suggestion.title)).toEqual(
			expect.arrayContaining(["Farrier handbook", "Stable handbook", "Farrier Amy"]),
		);
	});

	it("keeps ranking weights aligned with the indexed column order", async () => {
		await fts.rebuildIndex("articles", ["title", "body"], { title: 10, body: 1 });
		const executeQuery = vi.spyOn(db.getExecutor(), "executeQuery");
		const result = await searchWithDb(db, "farrier", { collections: ["articles"] });
		expect(executeQuery).toHaveBeenCalledTimes(2);
		expect(result.items.map((item) => item.slug)).toEqual(["title-match", "body-match"]);
		expect(result.items[0]?.snippet).toContain("<mark>Farrier</mark>");
	});

	it("does not retain metadata across search enablement changes", async () => {
		const executeQuery = vi.spyOn(db.getExecutor(), "executeQuery");

		executeQuery.mockClear();
		expect((await searchWithDb(db, "farrier", { collections: ["articles"] })).items).toHaveLength(
			2,
		);
		expect(executeQuery).toHaveBeenCalledTimes(2);

		await fts.disableSearch("articles");
		executeQuery.mockClear();
		expect((await searchWithDb(db, "farrier", { collections: ["articles"] })).items).toEqual([]);
		expect(executeQuery).toHaveBeenCalledTimes(1);

		await fts.enableSearch("articles", { weights: { title: 10, body: 1 } });
		executeQuery.mockClear();
		const result = await searchWithDb(db, "farrier", { collections: ["articles"] });
		expect(executeQuery).toHaveBeenCalledTimes(2);
		expect(result.items.map((item) => item.slug)).toEqual(["title-match", "body-match"]);
	});
});

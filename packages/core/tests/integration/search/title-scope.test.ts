import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { FTSManager } from "../../../src/search/fts-manager.js";
import { searchCollection, searchWithDb } from "../../../src/search/query.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

/**
 * `scope: "title"` restricts matching to the collection's title field, so
 * body-only matches drop out while the default full-document search keeps
 * them.
 */
describe("search: title scope", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		const fts = new FTSManager(db);

		await registry.createCollection({
			slug: "pages",
			label: "Pages",
			supports: ["search"],
		});
		await registry.createField("pages", {
			slug: "title",
			label: "Title",
			type: "string",
			searchable: true,
		});
		await registry.createField("pages", {
			slug: "content",
			label: "Content",
			type: "text",
			searchable: true,
		});
		await fts.enableSearch("pages");

		const repo = new ContentRepository(db);
		await repo.create({
			type: "pages",
			slug: "team",
			status: "published",
			data: { title: "Team", content: "Meet the people behind the studio." },
		});
		await repo.create({
			type: "pages",
			slug: "contact",
			status: "published",
			data: { title: "Contact", content: "Get in touch with our team." },
		});
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("default scope matches body text", async () => {
		const res = await searchWithDb(db, "team");
		const slugs = res.items.map((i) => i.slug).toSorted((a, b) => (a ?? "").localeCompare(b ?? ""));
		expect(slugs).toEqual(["contact", "team"]);
	});

	it("title scope drops body-only matches", async () => {
		const res = await searchWithDb(db, "team", { scope: "title" });
		expect(res.items.map((i) => i.slug)).toEqual(["team"]);
	});

	it("title scope contains FTS5 operator queries inside the column filter", async () => {
		const res = await searchWithDb(db, "x) OR (team", { scope: "title" });
		expect(res.items.map((i) => i.slug)).not.toContain("contact");
	});

	it("title scope applies to single-collection search", async () => {
		const res = await searchCollection(db, "pages", "team", { scope: "title" });
		expect(res.items.map((i) => i.slug)).toEqual(["team"]);
	});

	it("title scope uses the configured titleField", async () => {
		const registry = new SchemaRegistry(db);
		const fts = new FTSManager(db);
		await registry.createCollection({
			slug: "employees",
			label: "Employees",
			supports: ["search"],
		});
		await registry.createField("employees", {
			slug: "name",
			label: "Name",
			type: "string",
			searchable: true,
		});
		await registry.createField("employees", {
			slug: "bio",
			label: "Bio",
			type: "text",
			searchable: true,
		});
		await registry.updateCollection("employees", { titleField: "name" });
		await fts.enableSearch("employees");

		const repo = new ContentRepository(db);
		await repo.create({
			type: "employees",
			slug: "amy",
			status: "published",
			data: { name: "Amy Morse", bio: "Leads the team." },
		});

		const byName = await searchWithDb(db, "Amy", { collections: ["employees"], scope: "title" });
		expect(byName.items.map((i) => i.slug)).toEqual(["amy"]);

		const byBio = await searchWithDb(db, "team", { collections: ["employees"], scope: "title" });
		expect(byBio.items).toEqual([]);
	});

	it("title scope returns nothing when the title field is not indexed", async () => {
		const registry = new SchemaRegistry(db);
		const fts = new FTSManager(db);
		await registry.createCollection({
			slug: "notes",
			label: "Notes",
			supports: ["search"],
		});
		await registry.createField("notes", {
			slug: "body",
			label: "Body",
			type: "text",
			searchable: true,
		});
		await fts.enableSearch("notes");

		const repo = new ContentRepository(db);
		await repo.create({
			type: "notes",
			slug: "memo",
			status: "published",
			data: { body: "Quarterly planning memo." },
		});

		const res = await searchWithDb(db, "memo", { collections: ["notes"], scope: "title" });
		expect(res.items).toEqual([]);
	});
});

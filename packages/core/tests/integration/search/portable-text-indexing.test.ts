/**
 * FTS indexes Portable Text prose, not its JSON structure.
 *
 * Portable Text fields are stored as JSON in the content table. Feeding that
 * raw JSON to FTS5 pollutes the index with structural tokens — every post
 * matches searches for "normal" (a style value), "span", or "markDefs", and
 * snippets show JSON fragments instead of prose. The index must contain only
 * extracted text: span text, image alt/caption, code content.
 */

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { FTSManager } from "../../../src/search/fts-manager.js";
import { searchWithDb } from "../../../src/search/query.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("Portable Text FTS indexing", () => {
	let db: Kysely<Database>;
	let registry: SchemaRegistry;
	let repo: ContentRepository;
	let ftsManager: FTSManager;

	beforeEach(async () => {
		db = await setupTestDatabase();
		registry = new SchemaRegistry(db);
		repo = new ContentRepository(db);
		ftsManager = new FTSManager(db);

		await registry.createCollection({
			slug: "pages",
			label: "Pages",
			labelSingular: "Page",
			supports: ["drafts", "revisions", "search"],
		});
		// content first: searchSingleCollection snippets the first searchable
		// field (FTS column 2), and these tests assert content snippets.
		await registry.createField("pages", {
			slug: "content",
			label: "Content",
			type: "portableText",
			searchable: true,
		});
		await registry.createField("pages", {
			slug: "title",
			label: "Title",
			type: "string",
			required: true,
			searchable: true,
		});

		await ftsManager.enableSearch("pages");

		await repo.create({
			type: "pages",
			slug: "haunted-cinema",
			status: "published",
			data: {
				title: "Opening Night",
				content: [
					{
						_type: "block",
						_key: "b1",
						style: "normal",
						markDefs: [],
						children: [
							{ _type: "span", _key: "s1", text: "The haunted cinema screens forbidden films." },
						],
					},
					{ _type: "image", _key: "b2", alt: "festival poster", caption: "official artwork" },
					{ _type: "code", _key: "b3", code: "SELECT midnight FROM screenings" },
				],
			},
		});
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("does not match Portable Text structural tokens", async () => {
		for (const structural of ["normal", "span", "markDefs", "block"]) {
			const { items } = await searchWithDb(db, structural, { collections: ["pages"] });
			expect(items, `"${structural}" must not match`).toEqual([]);
		}
	});

	it("matches prose inside spans", async () => {
		const { items } = await searchWithDb(db, "haunted", { collections: ["pages"] });
		expect(items).toHaveLength(1);
		expect(items[0]!.slug).toBe("haunted-cinema");
	});

	it("matches image alt text, captions, and code content", async () => {
		for (const term of ["poster", "artwork", "midnight"]) {
			const { items } = await searchWithDb(db, term, { collections: ["pages"] });
			expect(items, `"${term}" must match`).toHaveLength(1);
		}
	});

	it("keeps legacy scalar values searchable", async () => {
		await repo.create({
			type: "pages",
			slug: "legacy-scalar",
			status: "published",
			data: { title: "Archive", content: null },
		});
		// Legacy rows can hold a JSON scalar in a portableText column; those
		// must stay raw-indexed rather than extract to NULL.
		await sql`UPDATE ec_pages SET content = '2024' WHERE slug = 'legacy-scalar'`.execute(db);
		await sql`UPDATE ec_pages SET content = '"velvet curtain"' WHERE slug = 'haunted-cinema'`.execute(
			db,
		);

		expect((await searchWithDb(db, "2024", { collections: ["pages"] })).items).toHaveLength(1);
		expect((await searchWithDb(db, "velvet", { collections: ["pages"] })).items).toHaveLength(1);
	});

	it("returns prose snippets, not JSON fragments", async () => {
		const { items } = await searchWithDb(db, "forbidden", { collections: ["pages"] });
		expect(items).toHaveLength(1);
		const snippet = items[0]!.snippet ?? "";
		expect(snippet).toContain("<mark>forbidden</mark>");
		expect(snippet).not.toContain("_type");
		expect(snippet).not.toContain("{");
	});
});

describe("Portable Text FTS indexing — json_tree column-name collisions", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("populates fields whose slug collides with a json_tree output column", async () => {
		// json_tree exposes columns named key/value/type/path/...; an
		// unqualified column reference inside the extraction subquery binds to
		// those instead of the ec_* column, silently indexing NULL.
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "notes",
			label: "Notes",
			labelSingular: "Note",
			supports: ["search"],
		});
		await registry.createField("notes", {
			slug: "value",
			label: "Value",
			type: "portableText",
			searchable: true,
		});

		// Create before enabling search so the row flows through
		// populateFromContent (the bare-reference path), not the triggers.
		await new ContentRepository(db).create({
			type: "notes",
			slug: "n1",
			status: "published",
			data: {
				value: [
					{
						_type: "block",
						_key: "b1",
						style: "normal",
						children: [{ _type: "span", _key: "s1", text: "A spectral apparition." }],
					},
				],
			},
		});
		await new FTSManager(db).enableSearch("notes");

		const { items } = await searchWithDb(db, "spectral", { collections: ["notes"] });
		expect(items).toHaveLength(1);
	});
});

/**
 * Blocks fields marked searchable are indexed by their Portable Text prose.
 *
 * A blocks value is an array of `{ _type, ...subFields }` objects. The FTS
 * expression extracts text/alt/caption/code at any depth, so Portable Text
 * sub-fields are findable; structural tokens (`_type`, block type slugs) are not.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { BlockTypeRegistry } from "../../../src/schema/block-type-registry.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { FTSManager } from "../../../src/search/fts-manager.js";
import { searchWithDb } from "../../../src/search/query.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const prose = (text: string) => [
	{
		_type: "block",
		_key: `k-${text.length}`,
		style: "normal",
		markDefs: [],
		children: [{ _type: "span", _key: "s1", text }],
	},
];

describe("blocks field FTS indexing", () => {
	let db: Kysely<Database>;
	let registry: SchemaRegistry;
	let repo: ContentRepository;
	let ftsManager: FTSManager;

	const search = (q: string) => searchWithDb(db, q, { collections: ["pages"] });

	beforeEach(async () => {
		db = await setupTestDatabase();
		registry = new SchemaRegistry(db);
		repo = new ContentRepository(db);
		ftsManager = new FTSManager(db);

		const blockTypes = new BlockTypeRegistry(db);
		await blockTypes.createBlockType({
			slug: "figure",
			label: "Figure",
			fields: [
				{ slug: "caption", label: "Caption", type: "string" },
				{ slug: "heading", label: "Heading", type: "string" },
			],
		});
		await blockTypes.createBlockType({
			slug: "gallery",
			label: "Gallery",
			fields: [
				{
					slug: "items",
					label: "Items",
					type: "repeater",
					validation: {
						subFields: [
							{ slug: "caption", label: "Caption", type: "string" },
							{ slug: "label", label: "Label", type: "string" },
						],
					},
				},
			],
		});
		await blockTypes.createBlockType({
			slug: "two_column",
			label: "Two column",
			fields: [
				{ slug: "left", label: "Left", type: "portableText" },
				{ slug: "right", label: "Right", type: "portableText" },
			],
		});
		await registry.createCollection({
			slug: "pages",
			label: "Pages",
			labelSingular: "Page",
			supports: ["drafts", "revisions", "search"],
		});
		await registry.createField("pages", {
			slug: "title",
			label: "Title",
			type: "string",
			required: true,
			searchable: true,
		});
		await registry.createField("pages", {
			slug: "layout",
			label: "Layout",
			type: "blocks",
			searchable: true,
			validation: { allowedTypes: ["two_column", "figure", "gallery"] },
		});
		await registry.createField("pages", {
			slug: "sidebar",
			label: "Sidebar",
			type: "portableText",
		});
		await ftsManager.enableSearch("pages");
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	const layoutWith = (left: string, right: string) => [
		{ _type: "two_column", _key: "b1", left: prose(left), right: prose(right) },
	];

	it("finds an entry whose only body text is inside a block's Portable Text sub-fields", async () => {
		await repo.create({
			type: "pages",
			slug: "about",
			status: "published",
			data: { title: "About", layout: layoutWith("Lighthouse keepers", "Harbor tides") },
		});

		for (const term of ["lighthouse", "harbor"]) {
			const { items } = await search(term);
			expect(items, `"${term}" must match`).toHaveLength(1);
			expect(items[0]!.slug).toBe("about");
		}
	});

	it("does not index structural tokens", async () => {
		await repo.create({
			type: "pages",
			slug: "about",
			status: "published",
			data: { title: "About", layout: layoutWith("Lighthouse keepers", "Harbor tides") },
		});

		for (const structural of ["two_column", "normal", "span", "markDefs"]) {
			expect((await search(structural)).items, `"${structural}" must not match`).toEqual([]);
		}
	});

	it("reindexes existing content when searchable is toggled on", async () => {
		await registry.updateField("pages", "layout", { searchable: false });
		await repo.create({
			type: "pages",
			slug: "about",
			status: "published",
			data: { title: "About", layout: layoutWith("Lighthouse keepers", "Harbor tides") },
		});
		expect((await search("lighthouse")).items).toEqual([]);

		await registry.updateField("pages", "layout", { searchable: true });
		expect((await search("lighthouse")).items).toHaveLength(1);
	});

	it("excludes drafts until published", async () => {
		const draft = await repo.create({
			type: "pages",
			slug: "secret",
			status: "draft",
			data: { title: "Secret", layout: layoutWith("Moonlit archive", "Hidden vault") },
		});
		expect((await search("moonlit")).items).toEqual([]);

		await repo.publish("pages", draft.id);
		const { items } = await search("moonlit");
		expect(items).toHaveLength(1);
		expect(items[0]!.slug).toBe("secret");
	});

	it("replaces old block text with new text on update", async () => {
		const entry = await repo.create({
			type: "pages",
			slug: "about",
			status: "published",
			data: { title: "About", layout: layoutWith("Lighthouse keepers", "Harbor tides") },
		});
		await repo.update("pages", entry.id, {
			data: { layout: layoutWith("Windmill millers", "Harbor tides") },
		});

		expect((await search("lighthouse")).items).toEqual([]);
		expect((await search("windmill")).items).toHaveLength(1);
	});

	it("removes soft-deleted entries from results", async () => {
		const entry = await repo.create({
			type: "pages",
			slug: "about",
			status: "published",
			data: { title: "About", layout: layoutWith("Lighthouse keepers", "Harbor tides") },
		});
		expect((await search("lighthouse")).items).toHaveLength(1);

		await repo.delete("pages", entry.id);
		expect((await search("lighthouse")).items).toEqual([]);
	});

	it("indexes a plain string sub-field slugged `caption` but not other string sub-fields", async () => {
		await repo.create({
			type: "pages",
			slug: "gallery",
			status: "published",
			data: {
				title: "Gallery",
				layout: [
					{ _type: "figure", _key: "f1", caption: "Seaside panorama", heading: "Quietheading" },
				],
			},
		});
		expect((await search("panorama")).items).toHaveLength(1);
		expect((await search("quietheading")).items).toEqual([]);
	});

	it("indexes a string sub-field slugged `caption` inside repeater rows", async () => {
		await repo.create({
			type: "pages",
			slug: "gallery",
			status: "published",
			data: {
				title: "Gallery",
				layout: [
					{
						_type: "gallery",
						_key: "g1",
						items: [{ _key: "r1", caption: "Tidepool closeup", label: "Quietlabel" }],
					},
				],
			},
		});
		expect((await search("tidepool")).items).toHaveLength(1);
		expect((await search("quietlabel")).items).toEqual([]);
	});

	it("does not find text in a non-searchable field", async () => {
		await repo.create({
			type: "pages",
			slug: "about",
			status: "published",
			data: { title: "About", layout: [], sidebar: prose("Unindexed gazebo") },
		});
		expect((await search("gazebo")).items).toEqual([]);
	});

	it("still indexes a searchable portableText field alongside blocks", async () => {
		await registry.updateField("pages", "sidebar", { searchable: true });
		await repo.create({
			type: "pages",
			slug: "about",
			status: "published",
			data: { title: "About", layout: [], sidebar: prose("Indexed gazebo") },
		});
		expect((await search("gazebo")).items).toHaveLength(1);
	});
});

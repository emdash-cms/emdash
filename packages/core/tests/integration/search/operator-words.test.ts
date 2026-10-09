import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { FTSManager } from "../../../src/search/fts-manager.js";
import { searchWithDb } from "../../../src/search/query.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

// Lowercase operator words must be treated as ordinary search terms, not
// FTS5 syntax, so they are quoted and prefix-matched like any other word.
describe("FTS operator words", () => {
	let db: Kysely<Database>;
	let repo: ContentRepository;
	let ftsManager: FTSManager;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		repo = new ContentRepository(db);
		ftsManager = new FTSManager(db);

		await registry.createCollection({
			slug: "articles",
			label: "Articles",
			supports: ["search"],
		});
		await registry.createField("articles", {
			slug: "title",
			label: "Title",
			type: "string",
			searchable: true,
		});
		await ftsManager.enableSearch("articles");
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	async function createArticle(slug: string, title: string): Promise<void> {
		await repo.create({
			type: "articles",
			slug,
			status: "published",
			publishedAt: new Date().toISOString(),
			data: { title },
		});
	}

	async function search(query: string): Promise<string[]> {
		const result = await searchWithDb(db, query, {
			collections: ["articles"],
			status: "published",
		});
		return result.items.map((item) => item.slug ?? "");
	}

	it("finds a title containing both an apostrophe and the word and", async () => {
		await createArticle("breeders", "Breeder's and Exhibitor's Association");

		expect(await search("Breeder's and Exhibitor's Association")).toEqual(["breeders"]);
		expect(await search("Breeder's and Exhibitor")).toEqual(["breeders"]);
	});

	it("finds a title containing an apostrophe and any of the operator words", async () => {
		await createArticle("obrien", "O'Brien Farm and Stables");
		await createArticle("nearby", "Riding near O'Connor");
		await createArticle("notes", "O'Hara's notes on shoeing");

		expect(await search("O'Brien Farm and Stables")).toEqual(["obrien"]);
		expect(await search("near O'Connor")).toEqual(["nearby"]);
		expect(await search("O'Hara's not shoeing")).toEqual(["notes"]);
	});

	it("keeps prefix matching for a query containing a lowercase operator word", async () => {
		await createArticle("boarding", "Boarding and training at Willow Farm");

		// A partial word, not a stem: Porter reduces "training" to "train" on both
		// sides, so "train" would match even without the prefix operator and would
		// not test anything. Only `"wil"*` reaches "Willow".
		expect(await search("boarding and wil")).toEqual(["boarding"]);
	});

	it("still honours an UPPERCASE operator", async () => {
		await createArticle("boarding", "Boarding and training at Willow Farm");
		await createArticle("shoeing", "Shoeing a young horse");

		expect(await search("boarding AND training")).toEqual(["boarding"]);
		expect(await search("boarding OR shoeing").then((r) => r.sort())).toEqual([
			"boarding",
			"shoeing",
		]);
		expect(await search("horse NOT young")).toEqual([]);
	});

	it("still treats a quoted phrase as a phrase", async () => {
		await createArticle("willow", "Boarding and training at Willow Farm");
		await createArticle("other", "Farm Willow supplies");

		expect(await search('"Willow Farm"')).toEqual(["willow"]);
	});
});

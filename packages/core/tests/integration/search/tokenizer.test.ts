import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { FTSManager } from "../../../src/search/fts-manager.js";
import { searchWithDb } from "../../../src/search/query.js";
import type { SearchConfig, SearchTokenizer } from "../../../src/search/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("FTS tokenizers", () => {
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

	async function getFtsDefinition(): Promise<string> {
		const result = await sql<{ sql: string }>`
			SELECT sql FROM sqlite_master
			WHERE type = 'table' AND name = '_emdash_fts_articles'
		`.execute(db);
		return result.rows[0]?.sql ?? "";
	}

	it("uses Porter stemming by default when tokenize is omitted", async () => {
		await createArticle("language", "Relations between languages");
		await ftsManager.enableSearch("articles");

		expect(await ftsManager.getSearchConfig("articles")).toEqual({
			enabled: true,
		});
		expect(await search("relational")).toEqual(["language"]);
		expect(await getFtsDefinition()).toContain("tokenize='porter unicode61'");
	});

	it("re-enables an existing collection with trigram and matches a mid-sentence Japanese term", async () => {
		await createArticle("tokyo", "これは東京都の観光案内です");
		await ftsManager.enableSearch("articles");

		expect(await search("東京都")).toEqual([]);

		await ftsManager.enableSearch("articles", { tokenize: "trigram" });

		expect(await ftsManager.getSearchConfig("articles")).toEqual({
			enabled: true,
			tokenize: "trigram",
		});
		expect(await search("東京都")).toEqual(["tokyo"]);
		expect(await search("東京")).toEqual([]);
		expect(await getFtsDefinition()).toContain("tokenize='trigram'");
	});

	it("preserves existing weights when changing only the tokenizer", async () => {
		await ftsManager.enableSearch("articles", { weights: { title: 10 } });

		await ftsManager.enableSearch("articles", { tokenize: "trigram" });

		expect(await ftsManager.getSearchConfig("articles")).toEqual({
			enabled: true,
			weights: { title: 10 },
			tokenize: "trigram",
		});
	});

	it("preserves trigram through disable, re-enable, schema rebuild, and missing-index repair", async () => {
		await createArticle("tokyo", "これは東京都の観光案内です");
		await ftsManager.enableSearch("articles", { tokenize: "trigram" });

		await ftsManager.disableSearch("articles");
		expect(await ftsManager.getSearchConfig("articles")).toEqual({
			enabled: false,
			tokenize: "trigram",
		});

		await ftsManager.enableSearch("articles");
		expect(await search("東京都")).toEqual(["tokyo"]);

		await registry.createField("articles", {
			slug: "summary",
			label: "Summary",
			type: "text",
			searchable: true,
		});
		expect(await getFtsDefinition()).toContain("tokenize='trigram'");
		expect(await search("東京都")).toEqual(["tokyo"]);

		await ftsManager.dropFtsTable("articles");
		await expect(ftsManager.verifyAndRepairIndex("articles")).resolves.toBe(true);
		expect(await getFtsDefinition()).toContain("tokenize='trigram'");
		expect(await search("東京都")).toEqual(["tokyo"]);
	});

	it("rejects unsupported runtime tokenizer values without replacing config or the index", async () => {
		await createArticle("tokyo", "これは東京都の観光案内です");
		await ftsManager.enableSearch("articles", { tokenize: "trigram" });
		const originalDefinition = await getFtsDefinition();
		const invalidTokenizer = "trigram'); DROP TABLE ec_articles; --" as SearchTokenizer;

		await expect(
			ftsManager.createFtsTable("articles", ["title"], undefined, invalidTokenizer),
		).rejects.toThrow("Unsupported FTS5 tokenizer");
		expect(await getFtsDefinition()).toBe(originalDefinition);

		await expect(
			ftsManager.rebuildIndex("articles", ["title"], undefined, invalidTokenizer),
		).rejects.toThrow("Unsupported FTS5 tokenizer");
		expect(await getFtsDefinition()).toBe(originalDefinition);
		expect(await search("東京都")).toEqual(["tokyo"]);

		await expect(
			ftsManager.setSearchConfig("articles", {
				enabled: true,
				tokenize: invalidTokenizer,
			}),
		).rejects.toThrow("Unsupported FTS5 tokenizer");
		expect(await ftsManager.getSearchConfig("articles")).toEqual({
			enabled: true,
			tokenize: "trigram",
		});

		await db
			.updateTable("_emdash_collections")
			.set({
				search_config: JSON.stringify({
					enabled: true,
					tokenize: invalidTokenizer,
				} satisfies SearchConfig),
			})
			.where("slug", "=", "articles")
			.execute();
		expect(await ftsManager.getSearchConfig("articles")).toBeNull();
		expect(await getFtsDefinition()).toBe(originalDefinition);
	});
});

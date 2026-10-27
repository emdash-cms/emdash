import { env } from "cloudflare:test";
import { Kysely, sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import type { Database } from "../../src/database/types.js";
import { getSuggestions, searchWithDb } from "../../src/search/query.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

let db: Kysely<Database>;

beforeAll(() => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
});

afterAll(async () => {
	await db.destroy();
});

afterEach(() => {
	vi.restoreAllMocks();
});

beforeEach(async () => {
	await resetD1Schema(db);
	await sql`
		CREATE TABLE _emdash_collections (
			id TEXT PRIMARY KEY,
			slug TEXT NOT NULL,
			search_config TEXT,
			title_field TEXT
		)
	`.execute(db);
	await sql`
		CREATE TABLE _emdash_fields (
			collection_id TEXT NOT NULL,
			slug TEXT NOT NULL,
			searchable INTEGER NOT NULL DEFAULT 0
		)
	`.execute(db);
	await sql`
		CREATE TABLE ec_articles (
			id TEXT PRIMARY KEY,
			slug TEXT,
			locale TEXT NOT NULL,
			status TEXT NOT NULL,
			deleted_at TEXT,
			title TEXT,
			body TEXT
		)
	`.execute(db);
	await sql`
		CREATE VIRTUAL TABLE _emdash_fts_articles USING fts5(
			id UNINDEXED,
			locale UNINDEXED,
			title,
			body
		)
	`.execute(db);
	await sql`
		INSERT INTO _emdash_collections (id, slug, search_config, title_field)
		VALUES ('articles-id', 'articles', ${JSON.stringify({
			enabled: true,
			weights: { title: 3, body: 1 },
		})}, 'title')
	`.execute(db);
	await sql`
		INSERT INTO _emdash_fields (collection_id, slug, searchable)
		VALUES ('articles-id', 'title', 1), ('articles-id', 'body', 1)
	`.execute(db);
	await sql`
		INSERT INTO ec_articles (id, slug, locale, status, title, body)
		VALUES ('article-1', 'article-one', 'en', 'published', 'The farrier', 'A useful horse shoeing guide')
	`.execute(db);
	await sql`
		INSERT INTO _emdash_fts_articles (id, locale, title, body)
		VALUES ('article-1', 'en', 'The farrier', 'A useful horse shoeing guide')
	`.execute(db);
	await sql`
		INSERT INTO _emdash_collections (id, slug, search_config, title_field)
		VALUES ('guides-id', 'guides', ${JSON.stringify({ enabled: true })}, NULL)
	`.execute(db);
	await sql`
		INSERT INTO _emdash_fields (collection_id, slug, searchable)
		VALUES ('guides-id', 'body', 1)
	`.execute(db);
	await sql`
		CREATE TABLE ec_guides (
			id TEXT PRIMARY KEY, slug TEXT, locale TEXT NOT NULL, status TEXT NOT NULL,
			deleted_at TEXT, body TEXT
		)
	`.execute(db);
	await sql`
		CREATE VIRTUAL TABLE _emdash_fts_guides USING fts5(id UNINDEXED, locale UNINDEXED, body)
	`.execute(db);
	await sql`
		INSERT INTO ec_guides (id, slug, locale, status, body)
		VALUES ('guide-1', 'guide-one', 'en', 'published', 'A farrier guide')
	`.execute(db);
	await sql`
		INSERT INTO _emdash_fts_guides (id, locale, body)
		VALUES ('guide-1', 'en', 'A farrier guide')
	`.execute(db);
});

function queryCounter() {
	const executor = db.getExecutor();
	return vi.spyOn(executor, "executeQuery");
}

describe("search metadata on D1", () => {
	it("uses one metadata query and one MATCH for matching and empty searches", async () => {
		const executeQuery = queryCounter();

		const matching = await searchWithDb(db, "farrier", {
			collections: ["articles"],
			status: "published",
		});
		expect(executeQuery).toHaveBeenCalledTimes(2);
		expect(matching.items).toHaveLength(1);
		expect(matching.items[0]).toMatchObject({
			title: "The farrier",
			snippet: "The <mark>farrier</mark>",
		});
		expect(matching.items[0]?.score).toBeGreaterThan(0);

		executeQuery.mockClear();
		const noMatch = await searchWithDb(db, "blacksmith", {
			collections: ["articles"],
			status: "published",
		});
		expect(executeQuery).toHaveBeenCalledTimes(2);
		expect(noMatch.items).toEqual([]);

		executeQuery.mockClear();
		const suggestions = await getSuggestions(db, "far", { collections: ["articles"] });
		expect(executeQuery).toHaveBeenCalledTimes(2);
		expect(suggestions.map((item) => item.title)).toEqual(["The farrier"]);

		executeQuery.mockClear();
		expect(await getSuggestions(db, "blacksmith", { collections: ["articles"] })).toEqual([]);
		expect(executeQuery).toHaveBeenCalledTimes(2);

		executeQuery.mockClear();
		expect(await getSuggestions(db, " \t\n")).toEqual([]);
		expect(executeQuery).toHaveBeenCalledTimes(0);
	});

	it("loads metadata once for multiple collections and skips disabled or missing indexes", async () => {
		await sql`
			INSERT INTO _emdash_collections (id, slug, search_config, title_field)
			VALUES
				('disabled-id', 'disabled', ${JSON.stringify({ enabled: false })}, NULL),
				('missing-id', 'missing', ${JSON.stringify({ enabled: true })}, NULL)
		`.execute(db);
		await sql`
			INSERT INTO _emdash_fields (collection_id, slug, searchable)
			VALUES ('disabled-id', 'title', 1), ('missing-id', 'title', 1)
		`.execute(db);
		await sql`
			CREATE TABLE ec_disabled (id TEXT, slug TEXT, locale TEXT, status TEXT, deleted_at TEXT, title TEXT)
		`.execute(db);
		await sql`
			CREATE VIRTUAL TABLE _emdash_fts_disabled USING fts5(id UNINDEXED, locale UNINDEXED, title)
		`.execute(db);
		await sql`
			CREATE TABLE ec_missing (id TEXT, slug TEXT, locale TEXT, status TEXT, deleted_at TEXT, title TEXT)
		`.execute(db);

		const executeQuery = queryCounter();
		const result = await searchWithDb(db, "farrier");

		expect(executeQuery).toHaveBeenCalledTimes(3);
		expect(result.items).toHaveLength(2);
		expect(
			result.items.map((item) => item.collection).toSorted((a, b) => a.localeCompare(b)),
		).toEqual(["articles", "guides"]);
		expect(result.items[0]?.collection).toBe("articles");
		expect(
			executeQuery.mock.calls.filter(([query]) => String(query.sql).includes("MATCH")),
		).toHaveLength(2);

		executeQuery.mockClear();
		const explicit = await searchWithDb(db, "farrier", {
			collections: [
				"articles",
				"guides",
				"disabled",
				"missing",
				...Array.from({ length: 120 }, (_, i) => `absent_${i}`),
			],
		});
		expect(executeQuery).toHaveBeenCalledTimes(3);
		expect(explicit.items).toEqual(result.items);

		executeQuery.mockClear();
		const suggestions = await getSuggestions(db, "far");
		expect(executeQuery).toHaveBeenCalledTimes(2);
		expect(suggestions.map((item) => item.collection)).toEqual(["articles"]);
	});
});

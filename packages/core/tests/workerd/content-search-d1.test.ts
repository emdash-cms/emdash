import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { handleContentList } from "../../src/api/handlers/content.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import type { Database } from "../../src/database/types.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { FTSManager } from "../../src/search/fts-manager.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

const FALLBACK = "content_search_fallback";
const FTS = "content_search_fts";
const cyrillic = "я".repeat(26);
const fallbackWildcard = "%_".repeat(23);
const fallbackBackslash = "\\".repeat(26);
const globWildcard = "*?".repeat(16);
const ftsTerm = "long-title-token-" + "a".repeat(33);
const fallback48 = "f".repeat(48);
const fallback49 = "g".repeat(49);
const fts49 = "h".repeat(49);
const fts50 = "i".repeat(50);
const shortFtsPrefix = "short-prefix";

let db: Kysely<Database>;
let repo: ContentRepository;

type ListResult = Extract<Awaited<ReturnType<typeof handleContentList>>, { success: true }>;
type SearchCase = { name: string; query: string; slugs: string[]; total: number };

async function list(collection: string, q: string): Promise<ListResult["data"]> {
	const result = await handleContentList(db, collection, { q, limit: 100 });
	if (!result.success) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.data;
}

beforeAll(async () => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	await runMigrations(db);
	const registry = new SchemaRegistry(db);
	for (const slug of [FALLBACK, FTS]) {
		await registry.createCollection({
			slug,
			label: slug,
			supports: slug === FTS ? ["search"] : [],
		});
		await registry.createField(slug, {
			slug: "title",
			label: "Title",
			type: "string",
			searchable: true,
		});
	}
	await new FTSManager(db).enableSearch(FTS, { weights: { title: 1 } });
	repo = new ContentRepository(db);

	for (const entry of [
		{ slug: "fallback-48", title: fallback48 },
		{ slug: "fallback-49", title: `prefix ${fallback49.toUpperCase()} suffix` },
		{ slug: "fallback-near-miss", title: `${fallback49.slice(0, 48)}z` },
		{ slug: "fallback-cyrillic", title: `до ${cyrillic}` },
		{ slug: "fallback-wildcards", title: `literal ${fallbackWildcard}` },
		{ slug: "fallback-wildcard-decoy", title: "x".repeat(23) },
		{ slug: "fallback-backslash", title: `literal ${fallbackBackslash}` },
		{ slug: "fallback-backslash-decoy", title: "ordinary text" },
	]) {
		await repo.create({ type: FALLBACK, slug: entry.slug, data: { title: entry.title } });
	}

	for (const entry of [
		{ slug: "unrelated-title-slug", title: ftsTerm },
		{ slug: `${ftsTerm}-slug-only`, title: "unrelated" },
		{ slug: `${cyrillic}-slug-only`, title: "unrelated" },
		{ slug: `${globWildcard}-slug-only`, title: "unrelated" },
		{ slug: "glob-wildcard-decoy", title: "unrelated" },
		{ slug: "prefix-not-a-match", title: `${ftsTerm.slice(0, -1)}b` },
		{ slug: `${fts49}-match`, title: "unrelated" },
		{ slug: `not-${fts49}-match`, title: "unrelated" },
		{ slug: `${fts50}-match`, title: "unrelated" },
		{ slug: `not-${fts50}-match`, title: "unrelated" },
		{ slug: `not-${globWildcard}-match`, title: "unrelated" },
		{ slug: `${shortFtsPrefix}-match`, title: "unrelated" },
		{ slug: `not-${shortFtsPrefix}-match`, title: "unrelated" },
	]) {
		await repo.create({ type: FTS, slug: entry.slug, data: { title: entry.title } });
	}
});

afterAll(async () => {
	await db.destroy();
});

describe("content list search on D1", () => {
	const fallbackCases: SearchCase[] = [
		{ name: "48-byte term", query: fallback48, slugs: ["fallback-48"], total: 1 },
		{ name: "49-byte term", query: fallback49, slugs: ["fallback-49"], total: 1 },
		{
			name: "52-byte Cyrillic term",
			query: cyrillic,
			slugs: ["fallback-cyrillic"],
			total: 1,
		},
		{
			name: "escaped wildcard term",
			query: fallbackWildcard,
			slugs: ["fallback-wildcards"],
			total: 1,
		},
		{
			name: "escaped backslash term",
			query: fallbackBackslash,
			slugs: ["fallback-backslash"],
			total: 1,
		},
	];

	it.each(fallbackCases)("fallback: $name", async ({ query, slugs, total }) => {
		const result = await list(FALLBACK, query);
		expect(result.items.map((item) => item.slug).toSorted()).toEqual(slugs.toSorted());
		expect(result.total).toBe(total);
	});

	const ftsCases: SearchCase[] = [
		{
			name: "long title and slug prefix",
			query: ftsTerm,
			slugs: ["unrelated-title-slug", `${ftsTerm}-slug-only`],
			total: 2,
		},
		{
			name: "Cyrillic slug prefix",
			query: cyrillic,
			slugs: [`${cyrillic}-slug-only`],
			total: 1,
		},
		{
			name: "escaped GLOB term",
			query: globWildcard,
			slugs: [`${globWildcard}-slug-only`],
			total: 1,
		},
		{ name: "49-byte slug prefix", query: fts49, slugs: [`${fts49}-match`], total: 1 },
		{ name: "50-byte slug prefix", query: fts50, slugs: [`${fts50}-match`], total: 1 },
		{
			name: "short slug prefix",
			query: shortFtsPrefix,
			slugs: [`${shortFtsPrefix}-match`],
			total: 1,
		},
	];

	it.each(ftsCases)("FTS: $name", async ({ query, slugs, total }) => {
		const result = await list(FTS, query);
		expect(result.items.map((item) => item.slug).toSorted()).toEqual(slugs.toSorted());
		expect(result.total).toBe(total);
	});
});

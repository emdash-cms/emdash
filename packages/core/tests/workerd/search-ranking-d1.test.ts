import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import type { Database } from "../../src/database/types.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { FTSManager } from "../../src/search/fts-manager.js";
import { searchWithDb } from "../../src/search/query.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

let db: Kysely<Database>;

beforeAll(async () => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	await runMigrations(db);

	const registry = new SchemaRegistry(db);
	for (const collection of ["search_pages", "search_posts"]) {
		await registry.createCollection({ slug: collection, label: collection, supports: ["search"] });
		await registry.createField(collection, {
			slug: "title",
			label: "Title",
			type: "string",
			searchable: true,
		});
		await registry.createField(collection, {
			slug: "body",
			label: "Body",
			type: "text",
			searchable: true,
		});
	}

	const fts = new FTSManager(db);
	await fts.enableSearch("search_pages", { weights: { title: 0.01, body: 10 } });
	await fts.enableSearch("search_posts", { weights: { title: 0.01, body: 10 } });
});

afterAll(async () => {
	await db.destroy();
});

it("ranks title matches and paginates normalized D1 search results without duplicates", async () => {
	const repository = new ContentRepository(db);
	await repository.create({
		type: "search_pages",
		slug: "roadmap",
		status: "published",
		data: { title: "Roadmap", body: "Future plans." },
	});

	for (let i = 0; i < 3; i++) {
		await repository.create({
			type: "search_posts",
			slug: `roadmap-mention-${i}`,
			status: "published",
			data: {
				title: `Post ${i}`,
				body: "roadmap ".repeat(12),
			},
		});
	}

	const firstPage = await searchWithDb(db, "roadmap", {
		collections: ["search_pages", "search_posts"],
		limit: 1,
	});

	expect(firstPage.items).toHaveLength(1);
	expect(firstPage.items[0]?.collection).toBe("search_pages");
	expect(firstPage.items[0]?.title).toBe("Roadmap");
	expect(firstPage.items[0]?.score).toBeGreaterThanOrEqual(0);
	expect(firstPage.items[0]?.score).toBeLessThanOrEqual(1);
	expect(Number.isFinite(firstPage.items[0]?.score)).toBe(true);
	expect(firstPage.nextCursor).toBeDefined();

	const secondPage = await searchWithDb(db, "roadmap", {
		collections: ["search_pages", "search_posts"],
		limit: 1,
		cursor: firstPage.nextCursor,
	});

	expect(secondPage.items).toHaveLength(1);
	expect(secondPage.items[0]?.collection).toBe("search_posts");
	expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id);
	expect(secondPage.items[0]?.score).toBeGreaterThanOrEqual(0);
	expect(secondPage.items[0]?.score).toBeLessThanOrEqual(1);
	expect(Number.isFinite(secondPage.items[0]?.score)).toBe(true);
});

it("accepts long queries without exceeding D1's bound-parameter limit", async () => {
	const repository = new ContentRepository(db);
	await repository.create({
		type: "search_pages",
		slug: "long-query",
		status: "published",
		data: { title: "École", body: "Future plans." },
	});
	const response = await searchWithDb(db, Array(110).fill("école").join(" "), {
		collections: ["search_pages", "search_posts"],
		limit: 1,
	});
	expect(response.items).toHaveLength(1);
	expect(response.items[0].title).toBe("École");
	expect(response.items[0].score).toBe(1);
});

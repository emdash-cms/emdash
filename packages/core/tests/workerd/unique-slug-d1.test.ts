import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../src/database/repositories/taxonomy.js";
import type { Database } from "../../src/database/types.js";
import { SchemaRegistry } from "../../src/schema/registry.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

// D1 rejects LIKE patterns longer than 50 bytes, so a `<base>-%` lookup
// fails once the base slug reaches 49 characters.
const LONG_TITLE = "A deliberately long title that slugifies past fifty bytes";
const LONG_SLUG = "a-deliberately-long-title-that-slugifies-past-fifty-bytes";

let db: Kysely<Database>;

beforeAll(async () => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	await runMigrations(db);
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: "posts", label: "Posts" });
	await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
});

afterAll(async () => {
	await db.destroy();
});

describe("unique slugs on D1 for long bases", () => {
	it("suffixes a taken content slug", async () => {
		const repo = new ContentRepository(db);
		await repo.create({ type: "posts", slug: LONG_SLUG, data: { title: LONG_TITLE } });
		await repo.create({ type: "posts", slug: `${LONG_SLUG}-4`, data: { title: LONG_TITLE } });
		await repo.create({ type: "posts", slug: `${LONG_SLUG}-x`, data: { title: LONG_TITLE } });
		await repo.create({ type: "posts", slug: `${LONG_SLUG}-9`, data: {}, locale: "fr" });

		expect(await repo.generateUniqueSlug("posts", LONG_TITLE, "en")).toBe(`${LONG_SLUG}-5`);
		expect(await repo.generateUniqueSlug("posts", LONG_TITLE)).toBe(`${LONG_SLUG}-10`);
	});

	it("duplicates content whose copy slug is taken", async () => {
		const repo = new ContentRepository(db);
		const original = await repo.create({
			type: "posts",
			slug: "original",
			data: { title: LONG_TITLE },
		});
		await repo.create({ type: "posts", slug: `${LONG_SLUG}-copy`, data: { title: LONG_TITLE } });

		const copy = await repo.duplicate("posts", original.id);

		expect(copy.slug).toBe(`${LONG_SLUG}-copy-1`);
	});

	it("suffixes a taken taxonomy term slug", async () => {
		const repo = new TaxonomyRepository(db);
		await repo.create({ name: "category", slug: LONG_SLUG, label: LONG_TITLE });
		await repo.create({ name: "category", slug: `${LONG_SLUG}-2`, label: LONG_TITLE });

		expect(await repo.generateUniqueSlug("category", LONG_TITLE)).toBe(`${LONG_SLUG}-3`);
	});
});

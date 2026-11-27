import { env } from "cloudflare:test";
import { Kysely, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { handleSitemapData, handleSitemapIndexData } from "../../src/api/handlers/seo.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { SeoRepository } from "../../src/database/repositories/seo.js";
import type { Database } from "../../src/database/types.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

const COLLECTION = "posts";
const CONTENT_ID = "post-1";
const CONTENT_UPDATED_AT = "2020-01-01T00:00:00.000Z";
const SEEDED_SEO_UPDATED_AT = "2021-01-01T00:00:00.000Z";

/**
 * Keep SQL guards independent of driver-specific boolean coercion. Local D1
 * accepts booleans, so enforce the narrower binding contract while executing
 * real SQL through the D1 driver.
 */
function strictD1Binding(database: D1Database): D1Database {
	return new Proxy(database, {
		get(target, property) {
			if (property === "prepare") {
				return (query: string) => {
					const statement = target.prepare(query);
					return new Proxy(statement, {
						get(statementTarget, statementProperty) {
							if (statementProperty === "bind") {
								return (...values: unknown[]) => {
									if (values.some((value) => typeof value === "boolean")) {
										throw new TypeError("D1 does not accept boolean bind parameters");
									}
									return statementTarget.bind(...values);
								};
							}
							const value = Reflect.get(statementTarget, statementProperty, statementTarget);
							return typeof value === "function" ? value.bind(statementTarget) : value;
						},
					});
				};
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

let db: Kysely<Database>;
let seo: SeoRepository;

beforeAll(async () => {
	db = new Kysely<Database>({
		dialect: new RawBindingD1Dialect({ database: strictD1Binding(env.DB) }),
	});
	await resetD1Schema(db);
	await runMigrations(db);

	const registry = new SchemaRegistry(db);
	await registry.createCollection({
		slug: COLLECTION,
		label: "Posts",
		labelSingular: "Post",
		hasSeo: true,
	});
	await registry.createField(COLLECTION, { slug: "title", label: "Title", type: "string" });
	await sql`
		INSERT INTO ec_posts (id, slug, status, updated_at, published_at, locale)
		VALUES (${CONTENT_ID}, 'post-1', 'published', ${CONTENT_UPDATED_AT}, ${CONTENT_UPDATED_AT}, 'en')
	`.execute(db);
	seo = new SeoRepository(db);
});

afterAll(async () => {
	await db.destroy();
});

async function sitemap() {
	const data = await handleSitemapData(db, COLLECTION);
	if (!data.success) throw new Error(data.error.message);
	const index = await handleSitemapIndexData(db, 2000);
	if (!index.success) throw new Error(index.error.message);
	return {
		entry: data.data.collections[0]?.entries[0],
		index: index.data.sitemaps[0],
	};
}

async function seedSeo(
	updatedAt: string,
	values: { title?: string | null; description?: string | null },
) {
	await db
		.insertInto("_emdash_seo")
		.values({
			collection: COLLECTION,
			content_id: CONTENT_ID,
			seo_title: values.title ?? null,
			seo_description: values.description ?? null,
			seo_no_index: 0,
			created_at: updatedAt,
			updated_at: updatedAt,
		})
		.execute();
}

describe("SEO timestamps in D1 sitemaps", () => {
	it("uses a changed SEO title for both sitemap lastmod values", async () => {
		await seo.upsert(COLLECTION, CONTENT_ID, { title: "New SEO title" });

		const result = await sitemap();
		expect(result.entry?.updatedAt).toBeDefined();
		expect(Date.parse(result.entry!.updatedAt)).toBeGreaterThan(Date.parse(CONTENT_UPDATED_AT));
		expect(result.index?.lastmod).toBe(result.entry?.updatedAt);
	});

	it("updates the timestamp for a partial SEO change", async () => {
		await db.deleteFrom("_emdash_seo").execute();
		await seedSeo(SEEDED_SEO_UPDATED_AT, { title: "Keep this title" });
		await seo.upsert(COLLECTION, CONTENT_ID, { description: "New description" });

		const row = await db.selectFrom("_emdash_seo").selectAll().executeTakeFirstOrThrow();
		expect(row.seo_title).toBe("Keep this title");
		expect(row.seo_description).toBe("New description");
		expect(row.updated_at).not.toBe(SEEDED_SEO_UPDATED_AT);

		const result = await sitemap();
		expect(result.entry?.updatedAt).toBe(result.index?.lastmod);
		expect(Date.parse(result.entry!.updatedAt)).toBeGreaterThan(Date.parse(SEEDED_SEO_UPDATED_AT));
	});

	it("preserves the timestamp when SEO values are unchanged", async () => {
		await db.deleteFrom("_emdash_seo").execute();
		await seedSeo(SEEDED_SEO_UPDATED_AT, { title: "Unchanged" });
		await seo.upsert(COLLECTION, CONTENT_ID, { title: "Unchanged" });

		const result = await sitemap();
		expect(result.entry?.updatedAt).toBe("2021-01-01T00:00:00.000Z");
		expect(result.index?.lastmod).toBe(result.entry?.updatedAt);
	});

	it("updates the timestamp when existing SEO values are cleared", async () => {
		await db.deleteFrom("_emdash_seo").execute();
		await seedSeo(SEEDED_SEO_UPDATED_AT, { title: "Clear me", description: "Clear me too" });
		await seo.upsert(COLLECTION, CONTENT_ID, { title: null, description: null });

		const result = await sitemap();
		expect(result.entry?.updatedAt).not.toBe("2021-01-01T00:00:00.000Z");
	});

	it("can set and clear noIndex through integer bindings", async () => {
		await db.deleteFrom("_emdash_seo").execute();
		expect((await seo.upsert(COLLECTION, CONTENT_ID, { noIndex: true })).noIndex).toBe(true);
		expect((await sitemap()).entry).toBeUndefined();
		expect((await seo.upsert(COLLECTION, CONTENT_ID, { noIndex: false })).noIndex).toBe(false);
		expect((await sitemap()).entry?.id).toBe(CONTENT_ID);
	});

	it("does not create a row or change lastmod for default-only first input", async () => {
		await db.deleteFrom("_emdash_seo").execute();
		await seo.upsert(COLLECTION, CONTENT_ID, { title: null });

		expect(await db.selectFrom("_emdash_seo").selectAll().execute()).toHaveLength(0);
		const result = await sitemap();
		expect(result.entry?.updatedAt).toBe(CONTENT_UPDATED_AT);
		expect(result.index?.lastmod).toBe(CONTENT_UPDATED_AT);
	});
});

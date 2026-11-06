import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { handleContentCreate } from "../../src/api/index.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { TaxonomyRepository } from "../../src/database/repositories/taxonomy.js";
import type { Database } from "../../src/database/types.js";
import { emdashLoader } from "../../src/loader.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

/**
 * D1 refuses a statement with more than 100 bound parameters, so a `where`
 * array longer than that used to fail the whole collection query.
 */
const COLLECTION = "long_in_d1";

let db: Kysely<Database>;

beforeAll(async () => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	await resetD1Schema(db);
	await runMigrations(db);

	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: COLLECTION, label: "Long IN" });
	await registry.createField(COLLECTION, { slug: "title", label: "Title", type: "string" });
	await registry.createField(COLLECTION, { slug: "series", label: "Series", type: "string" });
	await registry.createField(COLLECTION, { slug: "edition", label: "Edition", type: "string" });
	const entryIds: string[] = [];
	for (let i = 0; i < 130; i++) {
		const result = await handleContentCreate(db, COLLECTION, {
			data: { title: `Entry ${i}`, series: `s${i}`, edition: `e${i}` },
			status: "published",
			publishedAt: new Date(Date.UTC(2020, 0, 1, 0, i)).toISOString(),
		});
		if (!result.success) throw new Error("Failed to create entry");
		entryIds.push(result.data!.item.id);
	}

	await db
		.updateTable("_emdash_taxonomy_def_groups")
		.set({ collections: JSON.stringify([COLLECTION]) })
		.where("name", "in", ["category", "tag"])
		.execute();
	const taxonomies = new TaxonomyRepository(db);
	const categoryTerms = [];
	for (let i = 0; i < 120; i++) {
		// oxlint-disable-next-line no-await-in-loop -- deterministic fixture setup
		categoryTerms.push(
			await taxonomies.create({ name: "category", slug: `cat-${i}`, label: `Category ${i}` }),
		);
	}
	const tagTerms = [];
	for (let i = 0; i < 60; i++) {
		// oxlint-disable-next-line no-await-in-loop -- deterministic fixture setup
		tagTerms.push(await taxonomies.create({ name: "tag", slug: `tag-${i}`, label: `Tag ${i}` }));
	}
	for (let i = 0; i < 120; i++) {
		// oxlint-disable-next-line no-await-in-loop -- deterministic fixture setup
		await taxonomies.attachGroupsToEntry(COLLECTION, entryIds[i]!, [
			categoryTerms[i]!.translationGroup!,
		]);
	}
	const taxonomyEntry = await handleContentCreate(db, COLLECTION, {
		data: { title: "Taxonomy entry", series: "taxonomy", edition: "taxonomy" },
		status: "published",
		publishedAt: new Date(Date.UTC(2021, 0, 1)).toISOString(),
	});
	if (!taxonomyEntry.success) throw new Error("Failed to create taxonomy entry");
	await taxonomies.attachGroupsToEntry(
		COLLECTION,
		taxonomyEntry.data!.item.id,
		[...categoryTerms, ...tagTerms].map((term) => term.translationGroup!),
	);
}, 60_000);

afterAll(async () => {
	await db.destroy();
});

async function load(
	where: Record<string, string[]>,
	extra: { limit?: number; offset?: number } = {},
) {
	const result = await runWithContext({ db, editMode: false }, () =>
		emdashLoader().loadCollection!({
			filter: { type: COLLECTION, where, orderBy: { published_at: "asc" }, limit: 200, ...extra },
		}),
	);
	if (result.error) throw result.error;
	return result.entries.map((entry) => entry.data.series as string);
}

describe("collection where filters with long arrays on D1", () => {
	it("returns every match for a 120-value list", async () => {
		const series = Array.from({ length: 120 }, (_, i) => `s${i}`);
		expect(await load({ series })).toEqual(series);
	});

	it("pages a long list in the database", async () => {
		const series = Array.from({ length: 120 }, (_, i) => `s${i}`);
		expect(await load({ series }, { limit: 5, offset: 110 })).toEqual([
			"s110",
			"s111",
			"s112",
			"s113",
			"s114",
		]);
	});

	it("handles two long lists in one where", async () => {
		const series = Array.from({ length: 110 }, (_, i) => `s${i}`);
		const edition = Array.from({ length: 60 }, (_, i) => `e${i * 2}`);
		expect(await load({ series, edition })).toEqual(
			Array.from({ length: 55 }, (_, i) => `s${i * 2}`),
		);
	});

	it("filters a taxonomy with more than 100 slugs and a correlated field", async () => {
		const category = [...Array.from({ length: 120 }, (_, i) => `cat-${i}`), "missing"];
		expect(await load({ category, title: ["Taxonomy entry"] })).toEqual(["taxonomy"]);
	});

	it("matches a long taxonomy list without a field filter", async () => {
		const category = ["cat-119", ...Array.from({ length: 119 }, (_, i) => `missing-${i}`)];
		expect(await load({ category })).toEqual(["s119", "taxonomy"]);
	});

	it.each([false, true])(
		"ANDs two moderate taxonomy lists (field filter: %s)",
		async (withFieldFilter) => {
			const category = Array.from({ length: 48 }, (_, i) => `cat-${i}`);
			const tag = Array.from({ length: 48 }, (_, i) => `tag-${i}`);
			const title = ["Taxonomy entry", ...Array.from({ length: 49 }, (_, i) => `Missing ${i}`)];
			expect(await load({ category, tag, ...(withFieldFilter ? { title } : {}) })).toEqual([
				"taxonomy",
			]);
		},
	);

	it("returns every entry for a full long taxonomy list", async () => {
		const category = Array.from({ length: 120 }, (_, i) => `cat-${i}`);
		expect(await load({ category })).toEqual([
			...Array.from({ length: 120 }, (_, i) => `s${i}`),
			"taxonomy",
		]);
	});

	it("paginates a long taxonomy list in database order", async () => {
		const category = Array.from({ length: 120 }, (_, i) => `cat-${i}`);
		expect(await load({ category }, { limit: 1, offset: 120 })).toEqual(["taxonomy"]);
	});
});

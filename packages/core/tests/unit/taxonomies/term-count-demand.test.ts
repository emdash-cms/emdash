/**
 * Visible term counts are demand-driven: the aggregate over the assignment
 * pivot runs only for a caller that asked for counts. Assertions are on the SQL
 * actually executed, because with no object-cache backend `cachedQuery` is a
 * passthrough and every render pays the aggregate again.
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import type { Database as DatabaseSchema } from "../../../src/database/types.js";
import { runWithContext } from "../../../src/request-context.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";

// Mock loader.getDb so the runtime taxonomy functions read from our test db.
vi.mock("../../../src/loader.js", () => ({
	getDb: vi.fn(),
}));

import { prefetchLayoutData } from "../../../src/astro/prefetch.js";
import { getDb } from "../../../src/loader.js";
import {
	getTaxonomyTerms,
	invalidateTermCache,
	resetTaxonomyDefsCacheForTests,
} from "../../../src/taxonomies/index.js";

/** SQL of every query executed against the test database. */
let queries: string[] = [];

/** `per_collection` is the visible-count aggregate's subquery alias. */
function countAggregateQueries(): string[] {
	return queries.filter((q) => q.includes("per_collection"));
}

function termListQueries(): string[] {
	return queries.filter((q) => q.includes('from "taxonomies"'));
}

describe("visible term counts are only computed on demand", () => {
	let db: Kysely<DatabaseSchema>;

	beforeEach(async () => {
		queries = [];
		db = new Kysely<DatabaseSchema>({
			dialect: new SqliteDialect({ database: new Database(":memory:") }),
			log(event) {
				if (event.level === "query") queries.push(event.query.sql);
			},
		});
		await runMigrations(db);
		vi.mocked(getDb).mockResolvedValue(db);
		resetTaxonomyDefsCacheForTests();
		invalidateTermCache();

		// Migrations seed the `category` (hierarchical) and `tag` defs declaring
		// a `posts` collection; point them at the collection this test creates so
		// the aggregate runs against a real table.
		await new SchemaRegistry(db).createCollection({
			slug: "post",
			label: "Posts",
			labelSingular: "Post",
		});
		await db
			.updateTable("_emdash_taxonomy_defs")
			.set({ collections: JSON.stringify(["post"]) })
			.where("name", "in", ["category", "tag"])
			.execute();

		const taxRepo = new TaxonomyRepository(db);
		const contentRepo = new ContentRepository(db);
		const parent = await taxRepo.create({
			name: "category",
			slug: "tech",
			label: "Technology",
			data: { description: "All things tech" },
		});
		const child = await taxRepo.create({
			name: "category",
			slug: "web",
			label: "Web",
			parentId: parent.translationGroup ?? parent.id,
		});
		const tag = await taxRepo.create({ name: "tag", slug: "webdev", label: "WebDev" });

		for (const [slug, term] of [
			["published-one", parent],
			["published-two", parent],
			["published-three", child],
		] as const) {
			const entry = await contentRepo.create({
				type: "post",
				slug,
				status: "published",
				data: {},
			});
			await taxRepo.attachToEntry("post", entry.id, term.id);
			await taxRepo.attachToEntry("post", entry.id, tag.id);
		}
	});

	afterEach(async () => {
		resetTaxonomyDefsCacheForTests();
		invalidateTermCache();
		await db.destroy();
		vi.restoreAllMocks();
	});

	it("does not aggregate counts during the layout prefetch", async () => {
		await runWithContext({ editMode: false }, async () => {
			queries = [];
			await prefetchLayoutData();

			expect(countAggregateQueries()).toEqual([]);
			// The term lists themselves are still warmed, one query per taxonomy.
			expect(termListQueries()).toHaveLength(2);
		});
	});

	it("reuses the prefetched term list and aggregates once for a caller that wants counts", async () => {
		await runWithContext({ editMode: false }, async () => {
			await prefetchLayoutData();
			queries = [];

			const tags = await getTaxonomyTerms("tag", { includeCounts: false });
			expect(tags.map((t) => t.slug)).toEqual(["webdev"]);
			expect(tags[0]).not.toHaveProperty("count");
			expect(queries).toEqual([]);

			const categories = await getTaxonomyTerms("category");
			expect(categories[0]!.count).toBe(2);
			expect(categories[0]!.children[0]!.count).toBe(1);
			// One aggregate, and no second read of the warmed term list.
			expect(countAggregateQueries()).toHaveLength(1);
			expect(termListQueries()).toEqual([]);
		});
	});

	it("keeps hierarchy, description and locale on the count-free list", async () => {
		const [root] = await runWithContext({ editMode: false }, () =>
			getTaxonomyTerms("category", { includeCounts: false }),
		);

		expect(root!.slug).toBe("tech");
		expect(root!.description).toBe("All things tech");
		expect(root!.locale).toBe("en");
		expect(root!.children.map((c) => c.slug)).toEqual(["web"]);
		expect(root!.children[0]).not.toHaveProperty("count");
	});

	it("recomputes counts per request with no object-cache backend, and never without", async () => {
		for (const run of [1, 2]) {
			await runWithContext({ editMode: false }, async () => {
				queries = [];
				await prefetchLayoutData();
				expect(countAggregateQueries(), `prefetch run ${run}`).toEqual([]);

				const categories = await getTaxonomyTerms("category");
				expect(categories[0]!.count, `counted run ${run}`).toBe(2);
				expect(countAggregateQueries(), `aggregate run ${run}`).toHaveLength(1);
			});
		}
	});
});

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

// Mock loader.getDb so the runtime taxonomy functions read from our test db.
vi.mock("../../../src/loader.js", () => ({
	getDb: vi.fn(),
}));

import { getDb } from "../../../src/loader.js";
import { runWithContext } from "../../../src/request-context.js";
import {
	getAllTermsForEntries,
	getEntryTerms,
	invalidateTermCache,
} from "../../../src/taxonomies/index.js";

describe("getAllTermsForEntries", () => {
	let db: Kysely<Database>;
	let taxRepo: TaxonomyRepository;
	let contentRepo: ContentRepository;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		taxRepo = new TaxonomyRepository(db);
		contentRepo = new ContentRepository(db);
		vi.mocked(getDb).mockResolvedValue(db);
		invalidateTermCache();
	});

	afterEach(async () => {
		invalidateTermCache();
		await teardownTestDatabase(db);
		vi.restoreAllMocks();
	});

	it("returns empty map for empty entry list", async () => {
		const result = await getAllTermsForEntries("post", []);
		expect(result.size).toBe(0);
	});

	it("short-circuits without querying when no assignments exist", async () => {
		// Create terms but attach to nothing
		await taxRepo.create({ name: "tag", slug: "a", label: "A" });

		const post = await contentRepo.create({
			type: "post",
			slug: "p1",
			data: { title: "P1" },
		});

		const result = await getAllTermsForEntries("post", [post.id]);

		// Still returns the entry id, but with empty object
		expect(result.get(post.id)).toEqual({});
	});

	it("hydrates terms grouped by taxonomy name in a single query", async () => {
		const tag1 = await taxRepo.create({ name: "tag", slug: "web", label: "Web" });
		const tag2 = await taxRepo.create({ name: "tag", slug: "ai", label: "AI" });
		const cat = await taxRepo.create({ name: "category", slug: "news", label: "News" });

		const p1 = await contentRepo.create({
			type: "post",
			slug: "p1",
			data: { title: "P1" },
		});
		const p2 = await contentRepo.create({
			type: "post",
			slug: "p2",
			data: { title: "P2" },
		});

		await taxRepo.attachToEntry("post", p1.id, tag1.id);
		await taxRepo.attachToEntry("post", p1.id, tag2.id);
		await taxRepo.attachToEntry("post", p1.id, cat.id);
		await taxRepo.attachToEntry("post", p2.id, tag1.id);

		// Invalidate the hasAnyTermAssignments probe cached from earlier tests
		invalidateTermCache();

		const result = await getAllTermsForEntries("post", [p1.id, p2.id]);

		expect(result.size).toBe(2);

		const p1Terms = result.get(p1.id)!;
		expect(Object.keys(p1Terms).toSorted()).toEqual(["category", "tag"]);
		expect(p1Terms.tag.map((t) => t.slug).toSorted()).toEqual(["ai", "web"]);
		expect(p1Terms.category.map((t) => t.slug)).toEqual(["news"]);

		const p2Terms = result.get(p2.id)!;
		expect(Object.keys(p2Terms)).toEqual(["tag"]);
		expect(p2Terms.tag.map((t) => t.slug)).toEqual(["web"]);
	});

	it("scopes results to the requested collection", async () => {
		const tag = await taxRepo.create({ name: "tag", slug: "shared", label: "Shared" });

		const post = await contentRepo.create({
			type: "post",
			slug: "p",
			data: { title: "P" },
		});
		const page = await contentRepo.create({
			type: "page",
			slug: "pg",
			data: { title: "Pg" },
		});

		await taxRepo.attachToEntry("post", post.id, tag.id);
		await taxRepo.attachToEntry("page", page.id, tag.id);

		invalidateTermCache();

		const postTerms = await getAllTermsForEntries("post", [post.id, page.id]);
		// Only `post.id` should have the tag in post scope; page.id is a no-op here
		// since its assignment is to the `page` collection.
		expect(postTerms.get(post.id)?.tag?.[0].slug).toBe("shared");
		expect(postTerms.get(page.id)).toEqual({});
	});

	it("returns empty arrays for entries with no terms", async () => {
		const tag = await taxRepo.create({ name: "tag", slug: "one", label: "One" });
		const p1 = await contentRepo.create({
			type: "post",
			slug: "p1",
			data: { title: "P1" },
		});
		const p2 = await contentRepo.create({
			type: "post",
			slug: "p2",
			data: { title: "P2" },
		});
		await taxRepo.attachToEntry("post", p1.id, tag.id);

		invalidateTermCache();

		const result = await getAllTermsForEntries("post", [p1.id, p2.id]);
		expect(result.get(p1.id)?.tag?.[0].slug).toBe("one");
		expect(result.get(p2.id)).toEqual({});
	});

	it("primes the request cache so getEntryTerms doesn't re-query", async () => {
		// Extend the default "tag" taxonomy (seeded for `posts`) to also
		// apply to the `post` collection used in these tests. Without this,
		// the primer wouldn't seed the "tag" key for entries with no tags.
		await db
			.updateTable("_emdash_taxonomy_defs")
			.set({ collections: JSON.stringify(["posts", "post"]) })
			.where("name", "=", "tag")
			.execute();

		const tag = await taxRepo.create({ name: "tag", slug: "web", label: "Web" });
		const p1 = await contentRepo.create({
			type: "post",
			slug: "p1",
			data: { title: "P1" },
		});
		const p2 = await contentRepo.create({
			type: "post",
			slug: "p2",
			data: { title: "P2" },
		});
		await taxRepo.attachToEntry("post", p1.id, tag.id);

		invalidateTermCache();

		const getDbSpy = vi.mocked(getDb);

		await runWithContext({ editMode: false }, async () => {
			// Populate the cache via the batched API.
			await getAllTermsForEntries("post", [p1.id, p2.id]);

			const callsAfterBatch = getDbSpy.mock.calls.length;

			// These per-entry calls should hit the primed cache.
			const p1Tags = await getEntryTerms("post", p1.id, "tag");
			const p2Tags = await getEntryTerms("post", p2.id, "tag");
			const p1All = await getEntryTerms("post", p1.id); // the `*` key

			// No additional DB calls should have happened for the primed keys.
			expect(getDbSpy.mock.calls.length).toBe(callsAfterBatch);

			// And the values should match what the batch returned.
			expect(p1Tags.map((t) => t.slug)).toEqual(["web"]);
			expect(p2Tags).toEqual([]);
			expect(p1All.map((t) => t.slug)).toEqual(["web"]);
		});
	});

	it("does not leak primed entries across requests", async () => {
		await db
			.updateTable("_emdash_taxonomy_defs")
			.set({ collections: JSON.stringify(["posts", "post"]) })
			.where("name", "=", "tag")
			.execute();

		const tag = await taxRepo.create({ name: "tag", slug: "web", label: "Web" });
		const p1 = await contentRepo.create({
			type: "post",
			slug: "p1",
			data: { title: "P1" },
		});
		await taxRepo.attachToEntry("post", p1.id, tag.id);

		invalidateTermCache();

		await runWithContext({ editMode: false }, async () => {
			await getAllTermsForEntries("post", [p1.id]);
		});

		const getDbSpy = vi.mocked(getDb);
		const callsBeforeSecondRequest = getDbSpy.mock.calls.length;

		await runWithContext({ editMode: false }, async () => {
			// Different request context — the cache from the previous context
			// must not be visible here.
			await getEntryTerms("post", p1.id, "tag");
		});

		// At least one DB call should have happened in the second request.
		expect(getDbSpy.mock.calls.length).toBeGreaterThan(callsBeforeSecondRequest);
	});
});

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

vi.mock("../../../src/loader.js", () => ({
	getDb: vi.fn(),
}));

import { getDb } from "../../../src/loader.js";
import { getTaxonomyTerms, getTerm, invalidateTermCache } from "../../../src/taxonomies/index.js";

describe("taxonomy term counts (#581)", () => {
	let db: Kysely<Database>;
	let taxRepo: TaxonomyRepository;
	let contentRepo: ContentRepository;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		taxRepo = new TaxonomyRepository(db);
		contentRepo = new ContentRepository(db);
		vi.mocked(getDb).mockResolvedValue(db);
		invalidateTermCache();

		// The setupTestDatabaseWithCollections helper creates a singular
		// `post` collection while the seeded `category` taxonomy points at
		// `posts` (plural). Re-target it so attachments to the test
		// collection are counted.
		await db
			.updateTable("_emdash_taxonomy_defs")
			.set({ collections: JSON.stringify(["post"]) })
			.where("name", "=", "category")
			.execute();
	});

	afterEach(async () => {
		invalidateTermCache();
		await teardownTestDatabase(db);
		vi.restoreAllMocks();
	});

	it("excludes draft entries from getTaxonomyTerms counts", async () => {
		const term = await taxRepo.create({ name: "category", slug: "tech", label: "Tech" });

		const published = await contentRepo.create({
			type: "post",
			slug: "p1",
			data: { title: "P1" },
			status: "published",
		});
		const draft = await contentRepo.create({
			type: "post",
			slug: "p2",
			data: { title: "P2" },
			status: "draft",
		});

		await taxRepo.attachToEntry("post", published.id, term.id);
		await taxRepo.attachToEntry("post", draft.id, term.id);

		const terms = await getTaxonomyTerms("category");
		const tech = terms.find((t) => t.slug === "tech");
		expect(tech?.count).toBe(1);
	});

	it("excludes draft entries from getTerm count", async () => {
		const term = await taxRepo.create({ name: "category", slug: "tech", label: "Tech" });

		const published = await contentRepo.create({
			type: "post",
			slug: "p1",
			data: { title: "P1" },
			status: "published",
		});
		const draft = await contentRepo.create({
			type: "post",
			slug: "p2",
			data: { title: "P2" },
			status: "draft",
		});

		await taxRepo.attachToEntry("post", published.id, term.id);
		await taxRepo.attachToEntry("post", draft.id, term.id);

		const single = await getTerm("category", "tech");
		expect(single?.count).toBe(1);
	});

	it("excludes soft-deleted entries from term counts", async () => {
		const term = await taxRepo.create({ name: "category", slug: "news", label: "News" });

		const live = await contentRepo.create({
			type: "post",
			slug: "p1",
			data: { title: "P1" },
			status: "published",
		});
		const trashed = await contentRepo.create({
			type: "post",
			slug: "p2",
			data: { title: "P2" },
			status: "published",
		});

		await taxRepo.attachToEntry("post", live.id, term.id);
		await taxRepo.attachToEntry("post", trashed.id, term.id);

		await contentRepo.delete("post", trashed.id);

		const terms = await getTaxonomyTerms("category");
		expect(terms.find((t) => t.slug === "news")?.count).toBe(1);
	});

	it("returns zero count when only drafts are attached", async () => {
		const term = await taxRepo.create({ name: "category", slug: "empty", label: "Empty" });
		const draft = await contentRepo.create({
			type: "post",
			slug: "d",
			data: { title: "D" },
			status: "draft",
		});
		await taxRepo.attachToEntry("post", draft.id, term.id);

		const terms = await getTaxonomyTerms("category");
		expect(terms.find((t) => t.slug === "empty")?.count).toBe(0);
	});

	it("worker-lifetime cache serves stale counts until invalidateTermCache", async () => {
		const term = await taxRepo.create({ name: "category", slug: "tech", label: "Tech" });
		const first = await contentRepo.create({
			type: "post",
			slug: "p1",
			data: { title: "P1" },
			status: "published",
		});
		await taxRepo.attachToEntry("post", first.id, term.id);

		// First read populates the cache.
		const initial = await getTaxonomyTerms("category");
		expect(initial.find((t) => t.slug === "tech")?.count).toBe(1);

		// Add another published assignment without invalidating — the
		// cache should still serve the prior count.
		const second = await contentRepo.create({
			type: "post",
			slug: "p2",
			data: { title: "P2" },
			status: "published",
		});
		await taxRepo.attachToEntry("post", second.id, term.id);

		const stale = await getTaxonomyTerms("category");
		expect(stale.find((t) => t.slug === "tech")?.count).toBe(1);

		// After invalidation the next read recomputes.
		invalidateTermCache();
		const fresh = await getTaxonomyTerms("category");
		expect(fresh.find((t) => t.slug === "tech")?.count).toBe(2);
	});

	it("aggregates counts across every collection a taxonomy applies to", async () => {
		// Re-target `category` to span both `post` and `page` (both tables
		// exist via setupTestDatabaseWithCollections).
		await db
			.updateTable("_emdash_taxonomy_defs")
			.set({ collections: JSON.stringify(["post", "page"]) })
			.where("name", "=", "category")
			.execute();

		const term = await taxRepo.create({ name: "category", slug: "shared", label: "Shared" });

		const post = await contentRepo.create({
			type: "post",
			slug: "p",
			data: { title: "P" },
			status: "published",
		});
		const page = await contentRepo.create({
			type: "page",
			slug: "g",
			data: { title: "G" },
			status: "published",
		});
		await taxRepo.attachToEntry("post", post.id, term.id);
		await taxRepo.attachToEntry("page", page.id, term.id);

		invalidateTermCache();
		const terms = await getTaxonomyTerms("category");
		expect(terms.find((t) => t.slug === "shared")?.count).toBe(2);
	});
});

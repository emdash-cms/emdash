import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

// Mock loader.getDb so the runtime taxonomy functions read from our test db.
vi.mock("../../../src/loader.js", () => ({
	getDb: vi.fn(),
}));

import { getDb } from "../../../src/loader.js";
import { getTaxonomyTerms, invalidateTermCache } from "../../../src/taxonomies/index.js";

describeEachDialect("getTaxonomyTerms", (dialect) => {
	let ctx: DialectTestContext;
	let taxRepo: TaxonomyRepository;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		taxRepo = new TaxonomyRepository(ctx.db);
		vi.mocked(getDb).mockResolvedValue(ctx.db);
		invalidateTermCache();
	});

	afterEach(async () => {
		invalidateTermCache();
		await teardownForDialect(ctx);
		vi.restoreAllMocks();
	});

	it("includes the description for flat (non-hierarchical) taxonomies", async () => {
		// `tag` is seeded as non-hierarchical.
		await taxRepo.create({
			name: "tag",
			slug: "longevity",
			label: "Longevity",
			data: { description: "Healthy aging. wikidata:Q380274" },
		});
		await taxRepo.create({ name: "tag", slug: "wellness", label: "Wellness" });

		const terms = await getTaxonomyTerms("tag");

		expect(terms.map((t) => t.slug)).toEqual(["longevity", "wellness"]);
		expect(terms[0].description).toBe("Healthy aging. wikidata:Q380274");
		expect(terms[1].description).toBeUndefined();
	});

	it("includes the description for hierarchical taxonomies (control)", async () => {
		// `category` is seeded as hierarchical.
		await taxRepo.create({
			name: "category",
			slug: "tech",
			label: "Technology",
			data: { description: "All things tech" },
		});

		const terms = await getTaxonomyTerms("category");

		expect(terms).toHaveLength(1);
		expect(terms[0].description).toBe("All things tech");
	});
});

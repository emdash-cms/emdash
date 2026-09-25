/**
 * Regression coverage for issue #3210: WXR taxonomy pre-import should resolve
 * declared terms in batches rather than one SELECT per term.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import { preImportWxrTaxonomies } from "../../../src/import/wxr-taxonomies.js";
import { setupTestDatabase } from "../../utils/test-db.js";

function makeCategories(n: number): Array<{
	nicename: string;
	name: string;
	description?: string;
}> {
	return Array.from({ length: n }, (_, i) => ({
		nicename: `cat-${i}`,
		name: `Category ${i}`,
		description: `Description ${i}`,
	}));
}

describe("preImportWxrTaxonomies batching", () => {
	let findBySlugSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		findBySlugSpy = vi.spyOn(TaxonomyRepository.prototype, "findBySlug");
	});

	afterEach(() => {
		findBySlugSpy.mockRestore();
	});

	it("does not call findBySlug once per category", async () => {
		const db = await setupTestDatabase();
		const categories = makeCategories(120);

		const plan = await preImportWxrTaxonomies(db, [], categories, [], [], "en");

		expect(plan.termsCreated.category).toBe(120);
		// Batched resolution means findBySlug is no longer used for the
		// vocabulary lookup path. It may be called inside repo.create for
		// translationOf resolution, but never once per declared term.
		expect(findBySlugSpy.mock.calls.length).toBeLessThanOrEqual(5);
	});

	it("reuses existing terms with a single batched lookup per vocabulary", async () => {
		const db = await setupTestDatabase();
		const categories = makeCategories(120);

		const first = await preImportWxrTaxonomies(db, [], categories, [], [], "en");
		expect(first.termsCreated.category).toBe(120);

		findBySlugSpy.mockClear();
		const second = await preImportWxrTaxonomies(db, [], categories, [], [], "en");

		expect(second.termsReused.category).toBe(120);
		expect(second.termsCreated.category).toBeUndefined();
		// Already-existing rows should be resolved in a single batched SELECT
		// per vocabulary, not one SELECT per term.
		expect(findBySlugSpy.mock.calls.length).toBeLessThanOrEqual(2);
	});
});

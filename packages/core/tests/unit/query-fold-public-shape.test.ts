/**
 * Public hydrated shape of the byline/term fold fast path.
 *
 * `loader.ts` folds byline + taxonomy hydration into the content query as JSON
 * subqueries; `hydrateEntryBylines` / `hydrateEntryTerms` in query.ts parse that
 * JSON instead of issuing extra round trips. These tests assert the shape that
 * consumers actually read off `entry.data` (not the private FOLDED_* symbols):
 *
 *  - `data.bylines[i].byline.avatarMediaId` — a required BylineSummary field that
 *    templates read to render author avatars. A regression dropped it from the
 *    folded JSON, so it must be asserted at the public layer.
 *  - folded terms prime the per-entry request cache, so a later getEntryTerms()
 *    call serves from cache instead of issuing an N+1 query.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "../../src/database/types.js";
import { FOLDED_BYLINES, FOLDED_TERMS } from "../../src/loader.js";
import { getEmDashEntry } from "../../src/query.js";
import { runWithContext } from "../../src/request-context.js";
import { getEntryTerms } from "../../src/taxonomies/index.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../utils/test-db.js";

vi.mock("astro:content", () => ({
	getLiveCollection: vi.fn(),
	getLiveEntry: vi.fn(),
}));

import { getLiveEntry } from "astro:content";

/**
 * A content row as the live loader would return it: enumerable data plus the
 * non-enumerable FOLDED_* markers carrying the folded JSON payloads.
 */
function foldedEntry(opts: { id: string; slug: string; bylines: unknown[]; terms: unknown[] }) {
	const data: Record<string, unknown> = {
		id: opts.id,
		title: "Hello",
		status: "published",
		locale: "en",
	};
	Object.defineProperty(data, FOLDED_BYLINES, { value: opts.bylines, enumerable: false });
	Object.defineProperty(data, FOLDED_TERMS, { value: opts.terms, enumerable: false });
	return { id: opts.slug, data };
}

describe("byline/term fold public hydrated shape", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
		vi.mocked(getLiveEntry).mockReset();
	});

	it("exposes byline.avatarMediaId on the public shape", async () => {
		vi.mocked(getLiveEntry).mockResolvedValue({
			entry: foldedEntry({
				id: "post_1",
				slug: "hello",
				bylines: [
					{
						roleLabel: "Author",
						sortOrder: 0,
						byline: {
							id: "b1",
							slug: "ada",
							displayName: "Ada Lovelace",
							avatarMediaId: "media_ada_avatar",
							isGuest: 0,
						},
					},
				],
				terms: [],
			}),
			error: undefined,
			cacheHint: {},
			// eslint-disable-next-line typescript/no-explicit-any -- minimal live-entry shape for the mock
		} as any);

		const { entry } = await runWithContext({ editMode: false, db }, () =>
			getEmDashEntry("post", "hello", { locale: "en" }),
		);

		// eslint-disable-next-line typescript/no-explicit-any -- hydrated data is dynamically shaped
		const data = entry?.data as any;
		expect(data.bylines).toHaveLength(1);
		expect(data.bylines[0].byline.displayName).toBe("Ada Lovelace");
		expect(data.bylines[0].byline.avatarMediaId).toBe("media_ada_avatar");
		expect(data.byline.avatarMediaId).toBe("media_ada_avatar");
	});

	it("primes the per-entry term cache so getEntryTerms serves folded terms", async () => {
		// The folded payload carries a term that is NOT attached in
		// content_taxonomies. If priming works, getEntryTerms returns it from the
		// request cache; if it were dropped, getEntryTerms would query the DB and
		// find nothing (the N+1 regression this guards against).
		vi.mocked(getLiveEntry).mockResolvedValue({
			entry: foldedEntry({
				id: "post_1",
				slug: "hello",
				bylines: [],
				terms: [
					{
						id: "t1",
						name: "tag",
						slug: "news",
						label: "News",
						parent_id: null,
						locale: "en",
						translation_group: "tg1",
					},
				],
			}),
			error: undefined,
			cacheHint: {},
			// eslint-disable-next-line typescript/no-explicit-any -- minimal live-entry shape for the mock
		} as any);

		await runWithContext({ editMode: false, db }, async () => {
			const { entry } = await getEmDashEntry("post", "hello", { locale: "en" });
			// eslint-disable-next-line typescript/no-explicit-any -- hydrated data is dynamically shaped
			const data = entry?.data as any;
			expect(data.terms.tag.map((t: { slug: string }) => t.slug)).toEqual(["news"]);

			// Served from the primed request cache, not the (empty) DB.
			const terms = await getEntryTerms("post", "post_1", "tag");
			expect(terms.map((t) => t.slug)).toEqual(["news"]);
		});
	});
});

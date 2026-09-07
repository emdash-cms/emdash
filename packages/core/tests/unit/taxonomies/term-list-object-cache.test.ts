/**
 * A reorder has to bust the cached term list.
 *
 * `getTaxonomyTerms` serves a sibling group from the object cache, so the order
 * a visitor sees is whatever was cached at the last read. Without an object
 * cache backend `cachedQuery` runs its loader every time and a missing
 * invalidation is invisible — these tests inject one so it isn't.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("virtual:emdash/wait-until", () => ({ waitUntil: undefined }), { virtual: true });

vi.mock("../../../src/loader.js", () => ({
	getDb: vi.fn(),
	resetTaxonomyNamesCache: vi.fn(),
}));

import { handleTermReorder } from "../../../src/api/handlers/taxonomies.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import type { Database } from "../../../src/database/types.js";
import { getDb } from "../../../src/loader.js";
import {
	__setObjectCacheBackendForTests,
	type ObjectCacheBackend,
} from "../../../src/object-cache/index.js";
import { runWithContext } from "../../../src/request-context.js";
import { getTaxonomyTerms, resetTaxonomyDefsCacheForTests } from "../../../src/taxonomies/index.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

function memoryBackend(): ObjectCacheBackend {
	const store = new Map<string, string>();
	return {
		get: (k) => Promise.resolve(store.get(k) ?? null),
		set: (k, v) => {
			store.set(k, v);
			return Promise.resolve();
		},
		delete: (k) => {
			store.delete(k);
			return Promise.resolve();
		},
	};
}

async function flush(): Promise<void> {
	await new Promise((r) => setTimeout(r, 0));
}

describe("reordering terms invalidates the cached term list", () => {
	let db: Kysely<Database>;
	let repo: TaxonomyRepository;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		vi.mocked(getDb).mockResolvedValue(db);
		resetTaxonomyDefsCacheForTests();
		__setObjectCacheBackendForTests(memoryBackend(), { revalidate: 60_000, defaultTtl: 3600 });
		repo = new TaxonomyRepository(db);
	});

	afterEach(async () => {
		__setObjectCacheBackendForTests(null);
		await teardownTestDatabase(db);
		vi.restoreAllMocks();
	});

	/** Labels of `category`, read through the cached runtime helper. */
	function readLabels(): Promise<string[]> {
		return runWithContext({ editMode: false, db }, async () =>
			(await getTaxonomyTerms("category", { includeCounts: false })).map((term) => term.label),
		);
	}

	it("serves the new order after a reorder rather than the cached one", async () => {
		const zebra = await repo.create({ name: "category", slug: "z", label: "Zebra" });
		const apple = await repo.create({ name: "category", slug: "a", label: "Apple" });
		await flush();

		// Warm the cache with the creation order.
		expect(await readLabels()).toEqual(["Zebra", "Apple"]);
		await flush();

		const result = await handleTermReorder(db, "category", { ids: [apple.id, zebra.id] });
		expect(result.success).toBe(true);
		await flush();

		expect(await readLabels()).toEqual(["Apple", "Zebra"]);
	});

	// Guards the test above: if the backend were inert, the loader would run on
	// every read and the reorder would look invalidated whether or not it was.
	// The difference between the two tests is the invalidation itself.
	it("serves a warm term list to a write that never invalidated", async () => {
		const zebra = await repo.create({ name: "category", slug: "z", label: "Zebra" });
		await repo.create({ name: "category", slug: "a", label: "Apple" });
		await flush();

		expect(await readLabels()).toEqual(["Zebra", "Apple"]);
		await flush();

		// Reorder behind the cache's back, so nothing bumps the epoch.
		await db.updateTable("taxonomies").set({ sort_order: 5 }).where("id", "=", zebra.id).execute();

		expect(await readLabels()).toEqual(["Zebra", "Apple"]);
	});
});

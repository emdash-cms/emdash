import type { Kysely } from "kysely";
import { expect, it, vi } from "vitest";

vi.mock("virtual:emdash/wait-until", () => ({ waitUntil: undefined }), { virtual: true });

import { handleContentCreate } from "../../src/api/index.js";
import type { Database } from "../../src/database/types.js";
import { getTermCountsForCollection } from "../../src/loader.js";
import {
	__setObjectCacheBackendForTests,
	type ObjectCacheBackend,
} from "../../src/object-cache/index.js";
import { runWithContext } from "../../src/request-context.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../utils/test-db.js";

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

/** Let the deferred (`after`) cache write resolve. */
function flush(): Promise<void> {
	return new Promise((r) => setTimeout(r, 0));
}

/**
 * Regression: term counts must survive an object-cache round-trip.
 *
 * The counts carry a `Map`, but the object-cache codec is JSON-based and only
 * preserves `Date` — a `Map` serializes to `{}`. The seek planner gates on
 * `terms.size > 0`, which is `undefined` (falsy) on a plain object, so a stale
 * cache hit silently reverted to the slow scan the PR exists to avoid. The
 * original taxonomy tests ran with no backend configured, so `cachedQuery`
 * short-circuited to `load()` and never crossed the codec — this test forces
 * the round-trip by configuring a backend and reading twice.
 */
it("term counts survive an object-cache round-trip (Map is rebuilt on read)", async () => {
	const db: Kysely<Database> = await setupTestDatabaseWithCollections();
	// Wide revalidate window so the namespace epoch stays stable between reads.
	__setObjectCacheBackendForTests(memoryBackend(), { revalidate: 60_000, defaultTtl: 3600 });

	try {
		const news = "tax_news_group";
		await db
			.insertInto("taxonomies" as never)
			.values({
				id: news,
				name: "category",
				slug: "news",
				label: "News",
				locale: "en",
				translation_group: news,
			} as never)
			.execute();

		const created = await handleContentCreate(db, "post", {
			data: { title: "Published" },
			status: "published",
		});
		if (!created.success) throw new Error("Failed to create post");
		await db
			.insertInto("content_taxonomies" as never)
			.values({ collection: "post", entry_id: created.data!.item.id, taxonomy_id: news } as never)
			.execute();

		// First read: cache miss, loads from DB and defers the cache write.
		const first = await runWithContext({ editMode: false }, () =>
			getTermCountsForCollection(db, "post", "published", undefined),
		);
		expect(first.terms).toBeInstanceOf(Map);
		expect(first.terms.get(news)?.count).toBe(1);

		await flush();

		// Second read in a fresh request context: bypasses the per-request cache,
		// hits the object cache, and decodes through the codec. Before the fix,
		// `terms` came back as `{}` here (size `undefined`), disabling the seek plan.
		const second = await runWithContext({ editMode: false }, () =>
			getTermCountsForCollection(db, "post", "published", undefined),
		);
		expect(second.terms).toBeInstanceOf(Map);
		expect(second.terms.size).toBe(1);
		expect(second.terms.get(news)?.count).toBe(1);
		expect(second.total).toBe(1);
	} finally {
		__setObjectCacheBackendForTests(null);
		await teardownTestDatabase(db);
	}
});

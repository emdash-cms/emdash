import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("virtual:emdash/wait-until", () => ({ waitUntil: undefined }), { virtual: true });

// Mock loader.getDb so the runtime taxonomy functions read from our test db
// (and so we can simulate D1 being unavailable on the second, cached read).
vi.mock("../../../src/loader.js", () => ({ getDb: vi.fn() }));

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import type { Database } from "../../../src/database/types.js";
import { getDb } from "../../../src/loader.js";
import {
	__setObjectCacheBackendForTests,
	type ObjectCacheBackend,
} from "../../../src/object-cache/index.js";
import { runWithContext } from "../../../src/request-context.js";
import { getEntryTerms, getTermsForEntries } from "../../../src/taxonomies/index.js";
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

describe("entry-term reads are served from the object cache", () => {
	let db: Kysely<Database>;
	let postId: string;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		vi.mocked(getDb).mockResolvedValue(db);

		// Configure the object cache up front (wide revalidate window so the
		// namespace epoch stays stable across reads). Injecting before any
		// write means the seeding writes' deferred epoch bumps resolve the
		// backend to this stub rather than triggering the virtual-module import.
		__setObjectCacheBackendForTests(memoryBackend(), { revalidate: 60_000, defaultTtl: 3600 });

		const taxRepo = new TaxonomyRepository(db);
		const contentRepo = new ContentRepository(db);
		const tag = await taxRepo.create({ name: "tag", slug: "web", label: "Web" });
		const post = await contentRepo.create({ type: "post", slug: "p1", data: { title: "P1" } });
		postId = post.id;
		await taxRepo.attachToEntry("post", post.id, tag.id);

		// Let the seeding writes' deferred epoch bumps settle before the reads.
		await flush();
	});

	afterEach(async () => {
		__setObjectCacheBackendForTests(null);
		await teardownTestDatabase(db);
		vi.restoreAllMocks();
	});

	it("getEntryTerms serves the second read from KV without touching D1", async () => {
		const first = await runWithContext({ editMode: false, db }, () =>
			getEntryTerms("post", postId, "tag"),
		);
		expect(first.map((t) => t.slug)).toEqual(["web"]);
		await flush(); // let the deferred cache set land

		// Simulate D1 being unavailable — a cached read must not need it.
		vi.mocked(getDb).mockRejectedValue(new Error("D1 unavailable"));

		const second = await runWithContext({ editMode: false, db }, () =>
			getEntryTerms("post", postId, "tag"),
		);
		expect(second.map((t) => t.slug)).toEqual(["web"]);
	});

	it("getTermsForEntries round-trips its Map through the cache (no D1 on hit)", async () => {
		const first = await runWithContext({ editMode: false, db }, () =>
			getTermsForEntries("post", [postId], "tag"),
		);
		expect(first.get(postId)?.map((t) => t.slug)).toEqual(["web"]);
		await flush();

		vi.mocked(getDb).mockRejectedValue(new Error("D1 unavailable"));

		const second = await runWithContext({ editMode: false, db }, () =>
			getTermsForEntries("post", [postId], "tag"),
		);
		// Map rebuilt correctly from the cached array-of-pairs.
		expect(second).toBeInstanceOf(Map);
		expect(second.get(postId)?.map((t) => t.slug)).toEqual(["web"]);
	});
});

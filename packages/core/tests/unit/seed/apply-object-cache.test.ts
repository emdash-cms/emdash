import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("virtual:emdash/wait-until", () => ({ waitUntil: undefined }), { virtual: true });

import type { Database } from "../../../src/database/types.js";
import { waitForDeferredTasks } from "../../../src/deferred-tasks.js";
import {
	__setObjectCacheBackendForTests,
	cachedQuery,
	contentCacheNamespaces,
	getLastContentWriteAt,
	type ObjectCacheBackend,
} from "../../../src/object-cache/index.js";
import { applySeed } from "../../../src/seed/apply.js";
import type { SeedFile } from "../../../src/seed/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const COLLECTIONS = ["menu_items", "experiences", "gallery_items", "pages"];
const ENTRIES_PER_COLLECTION = 28;
const CACHE_CONFIG = { revalidate: 60_000, defaultTtl: 3600 };

function sampleContentSeed(): SeedFile {
	return {
		version: "1",
		collections: COLLECTIONS.map((slug) => ({
			slug,
			label: slug,
			fields: [{ slug: "title", label: "Title", type: "string" }],
		})),
		content: Object.fromEntries(
			COLLECTIONS.map((slug) => [
				slug,
				Array.from({ length: ENTRIES_PER_COLLECTION }, (_, i) => ({
					id: `${slug}-${i}`,
					slug: `${slug}-${i}`,
					status: "published" as const,
					data: { title: `${slug} ${i}` },
				})),
			]),
		),
	};
}

function countingBackend() {
	const store = new Map<string, string>();
	const writes = new Map<string, number>();
	const backend: ObjectCacheBackend = {
		get: (key) => Promise.resolve(store.get(key) ?? null),
		set: (key, value) => {
			store.set(key, value);
			writes.set(key, (writes.get(key) ?? 0) + 1);
			return Promise.resolve();
		},
		delete: (key) => {
			store.delete(key);
			return Promise.resolve();
		},
	};
	return { backend, store, writes };
}

describe("applySeed with an object cache", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
		__setObjectCacheBackendForTests(null);
	});

	it("writes each invalidated epoch to the backend once for a seed with sample content", async () => {
		const { backend, store, writes } = countingBackend();
		__setObjectCacheBackendForTests(backend, CACHE_CONFIG);
		const pages = contentCacheNamespaces("pages");

		await cachedQuery({ namespace: pages, key: "before", load: async () => "stale" });
		await waitForDeferredTasks();

		await applySeed(db, sampleContentSeed(), { includeContent: true, onConflict: "skip" });
		await waitForDeferredTasks();

		const epochWrites = Object.fromEntries(
			[...writes].filter(([key]) => key.startsWith("em:epoch:")),
		);
		for (const slug of COLLECTIONS) {
			expect(epochWrites).toHaveProperty([`em:epoch:content:v2:${slug}`]);
			expect(epochWrites).toHaveProperty([`em:epoch:content:${slug}`]);
		}
		expect(epochWrites).toEqual(
			Object.fromEntries(Object.keys(epochWrites).map((key) => [key, 1])),
		);
		expect(writes.get("em:last-content-write-at")).toBe(1);
		expect(store.get("em:last-content-write-at")).toBe(String(await getLastContentWriteAt()));

		// Cached by the seeding isolate under its local epochs.
		await cachedQuery({ namespace: pages, key: "after", load: async () => "seeded" });
		await waitForDeferredTasks();

		// Another isolate starts with an empty epoch cache and reads the backend.
		__setObjectCacheBackendForTests(backend, CACHE_CONFIG);
		const before = await cachedQuery({
			namespace: pages,
			key: "before",
			load: async () => "fresh",
		});
		const load = vi.fn(async () => "reloaded");
		const after = await cachedQuery({ namespace: pages, key: "after", load });

		expect(before).toBe("fresh");
		expect(after).toBe("seeded");
		expect(load).not.toHaveBeenCalled();
	});
});

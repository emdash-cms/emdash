import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("virtual:emdash/wait-until", () => ({ waitUntil: undefined }), { virtual: true });
vi.mock("astro:content", () => ({
	getLiveCollection: vi.fn(),
	getLiveEntry: vi.fn(),
}));

import { getLiveCollection, getLiveEntry } from "astro:content";

import type { Database } from "../../src/database/types.js";
import { CURSOR_RAW_VALUES } from "../../src/loader.js";
import {
	__setObjectCacheBackendForTests,
	invalidateCollectionCache,
	type ObjectCacheBackend,
} from "../../src/object-cache/index.js";
import { getEmDashCollection, getEmDashEntry } from "../../src/query.js";
import { runWithContext } from "../../src/request-context.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../utils/test-db.js";

function spyBackend(): ObjectCacheBackend {
	const store = new Map<string, string>();
	return {
		get: (key) => Promise.resolve(store.get(key) ?? null),
		set: (key, value) => {
			store.set(key, value);
			return Promise.resolve();
		},
		delete: (key) => {
			store.delete(key);
			return Promise.resolve();
		},
	};
}

async function flush(): Promise<void> {
	await new Promise((r) => setTimeout(r, 0));
}

describe("object cache: content read-through", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		__setObjectCacheBackendForTests(spyBackend(), { revalidate: 1000, defaultTtl: 3600 });
		vi.mocked(getLiveCollection).mockReset();
		vi.mocked(getLiveEntry).mockReset();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
		__setObjectCacheBackendForTests(null);
	});

	function mockEntries() {
		const data: Record<string, unknown> = {
			id: "db-1",
			title: "Hello",
			status: "published",
			createdAt: new Date("2025-01-01T00:00:00.000Z"),
		};
		// The loader attaches raw date strings under a non-enumerable symbol;
		// emulate it so we can assert the snapshot preserves it.
		Object.defineProperty(data, CURSOR_RAW_VALUES, {
			value: { created_at: "2025-01-01T00:00:00Z" },
			enumerable: false,
			configurable: false,
			writable: false,
		});
		return [{ id: "hello", slug: "hello", status: "published", data, cacheHint: {} }];
	}

	it("serves a second identical query from cache without re-querying the loader", async () => {
		vi.mocked(getLiveCollection).mockResolvedValue({
			entries: mockEntries(),
			error: undefined,
			cacheHint: {},
			// eslint-disable-next-line typescript/no-explicit-any -- mocked loader result
		} as any);

		await runWithContext({ editMode: false, db }, () => getEmDashCollection("post"));
		await flush();
		const second = await runWithContext({ editMode: false, db }, () => getEmDashCollection("post"));

		expect(getLiveCollection).toHaveBeenCalledTimes(1);
		expect(second.entries).toHaveLength(1);
		// Date survives the cache round-trip.
		const createdAt = (second.entries[0]!.data as { createdAt: unknown }).createdAt;
		expect(createdAt).toBeInstanceOf(Date);
		// The cursor-raw symbol is rebuilt on the cached entry.
		expect(Reflect.get(second.entries[0]!.data as object, CURSOR_RAW_VALUES)).toEqual({
			created_at: "2025-01-01T00:00:00Z",
		});
	});

	it("reloads after the collection is invalidated by a write", async () => {
		vi.mocked(getLiveCollection).mockResolvedValue({
			entries: mockEntries(),
			error: undefined,
			cacheHint: {},
			// eslint-disable-next-line typescript/no-explicit-any -- mocked loader result
		} as any);

		await runWithContext({ editMode: false, db }, () => getEmDashCollection("post"));
		await flush();
		await runWithContext({ editMode: false, db }, () => getEmDashCollection("post"));
		expect(getLiveCollection).toHaveBeenCalledTimes(1);

		invalidateCollectionCache("post");
		await flush();

		await runWithContext({ editMode: false, db }, () => getEmDashCollection("post"));
		expect(getLiveCollection).toHaveBeenCalledTimes(2);
	});

	it("bypasses the cache in edit mode", async () => {
		vi.mocked(getLiveCollection).mockResolvedValue({
			entries: mockEntries(),
			error: undefined,
			cacheHint: {},
			// eslint-disable-next-line typescript/no-explicit-any -- mocked loader result
		} as any);

		await runWithContext({ editMode: true, db }, () => getEmDashCollection("post"));
		await flush();
		await runWithContext({ editMode: true, db }, () => getEmDashCollection("post"));
		expect(getLiveCollection).toHaveBeenCalledTimes(2);
	});

	it("does not cache a not-yet-visible scheduled entry", async () => {
		// Scheduled for the future → currently hidden. Caching the "null" result
		// would keep it hidden past its go-live time, since visibility flips on
		// the clock rather than on a write.
		const data: Record<string, unknown> = {
			id: "db-future",
			title: "Future",
			status: "scheduled",
			scheduledAt: new Date(Date.now() + 60_000),
		};
		vi.mocked(getLiveEntry).mockResolvedValue({
			entry: { id: "future", slug: "future", status: "scheduled", data, cacheHint: {} },
			error: undefined,
			cacheHint: {},
			// eslint-disable-next-line typescript/no-explicit-any -- mocked loader result
		} as any);

		const first = await runWithContext({ editMode: false, db }, () =>
			getEmDashEntry("post", "future"),
		);
		await flush();
		const second = await runWithContext({ editMode: false, db }, () =>
			getEmDashEntry("post", "future"),
		);

		expect(first.entry).toBeNull();
		expect(second.entry).toBeNull();
		// Re-resolved rather than served from a stale cached "null".
		expect(getLiveEntry).toHaveBeenCalledTimes(2);
	});
});

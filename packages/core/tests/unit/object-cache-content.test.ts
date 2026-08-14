import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("virtual:emdash/wait-until", () => ({ waitUntil: undefined }), { virtual: true });
vi.mock("astro:content", () => ({
	getLiveCollection: vi.fn(),
	getLiveEntry: vi.fn(),
}));

import { getLiveCollection, getLiveEntry } from "astro:content";

import { ContentRepository } from "../../src/database/repositories/content.js";
import { RevisionRepository } from "../../src/database/repositories/revision.js";
import { ScheduledNotDueError } from "../../src/database/repositories/types.js";
import type { Database } from "../../src/database/types.js";
import { CURSOR_RAW_VALUES } from "../../src/loader.js";
import { encode } from "../../src/object-cache/codec.js";
import {
	__setObjectCacheBackendForTests,
	cachedQuery,
	invalidateCollectionCache,
	invalidateObjectCache,
	type ObjectCacheBackend,
} from "../../src/object-cache/index.js";
import { getEmDashCollection, getEmDashEntry } from "../../src/query.js";
import { runWithContext } from "../../src/request-context.js";
import { createPostFixture } from "../utils/fixtures.js";
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

function backendWithCachedValue(value: unknown): ObjectCacheBackend {
	const encoded = encode({ e: [0, 0, 0, 0], v: value });
	return {
		get: (key) => Promise.resolve(key.includes(":epoch:") ? null : encoded),
		set: () => Promise.resolve(),
		delete: () => Promise.resolve(),
	};
}

function backendWithOldContentValue(value: unknown): ObjectCacheBackend {
	const encoded = encode({ e: [0, 0, 0], v: value });
	return {
		get: (key) => {
			if (key.includes(":epoch:")) return Promise.resolve(null);
			return Promise.resolve(key.includes(":content:post,") ? encoded : null);
		},
		set: () => Promise.resolve(),
		delete: () => Promise.resolve(),
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
			liveRevisionId: "live-1",
			draftRevisionId: "draft-1",
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

	it("omits revision metadata from anonymous collection results", async () => {
		vi.mocked(getLiveCollection).mockResolvedValue({
			entries: mockEntries(),
			error: undefined,
			cacheHint: {},
			// eslint-disable-next-line typescript/no-explicit-any -- mocked loader result
		} as any);

		const result = await runWithContext({ editMode: false, db }, () => getEmDashCollection("post"));

		expect(result.entries[0]!.data).not.toHaveProperty("liveRevisionId");
		expect(result.entries[0]!.data).not.toHaveProperty("draftRevisionId");
	});

	it("omits revision metadata from anonymous entry results", async () => {
		const [entry] = mockEntries();
		vi.mocked(getLiveEntry).mockResolvedValue({
			entry,
			error: undefined,
			cacheHint: {},
			// eslint-disable-next-line typescript/no-explicit-any -- mocked loader result
		} as any);

		const result = await runWithContext({ editMode: false, db }, () =>
			getEmDashEntry("post", "hello"),
		);

		expect(result.entry!.data).not.toHaveProperty("liveRevisionId");
		expect(result.entry!.data).not.toHaveProperty("draftRevisionId");
	});

	it("sanitizes anonymous collection snapshots written by earlier releases", async () => {
		const [entry] = mockEntries();
		__setObjectCacheBackendForTests(
			backendWithCachedValue({
				ok: true,
				value: {
					entries: [{ ...entry, data: { ...entry!.data, __emdashCursorRaw: {} } }],
					cacheHint: {},
				},
			}),
		);

		const result = await runWithContext({ editMode: false, db }, () => getEmDashCollection("post"));

		expect(getLiveCollection).not.toHaveBeenCalled();
		expect(result.entries[0]!.data).not.toHaveProperty("liveRevisionId");
		expect(result.entries[0]!.data).not.toHaveProperty("draftRevisionId");
	});

	it("sanitizes anonymous entry snapshots written by earlier releases", async () => {
		const [entry] = mockEntries();
		__setObjectCacheBackendForTests(
			backendWithCachedValue({
				ok: true,
				value: {
					entry: { ...entry, data: { ...entry!.data, __emdashCursorRaw: {} } },
					isPreview: false,
					cacheHint: {},
				},
			}),
		);

		const result = await runWithContext({ editMode: false, db }, () =>
			getEmDashEntry("post", "hello"),
		);

		expect(getLiveEntry).not.toHaveBeenCalled();
		expect(result.entry!.data).not.toHaveProperty("liveRevisionId");
		expect(result.entry!.data).not.toHaveProperty("draftRevisionId");
	});

	it("does not read scheduled content cached under the previous namespace", async () => {
		const stale = {
			id: "db-due",
			slug: "initial-slug",
			data: { id: "db-due", title: "Initial title", status: "scheduled" },
		};
		__setObjectCacheBackendForTests(
			backendWithOldContentValue({
				ok: true,
				value: {
					entry: stale,
					isPreview: false,
					cacheHint: {},
				},
			}),
		);
		vi.mocked(getLiveEntry).mockResolvedValue({
			entry: {
				id: "db-due",
				slug: "approved-slug",
				data: { id: "db-due", title: "Final title", status: "published" },
			},
			error: undefined,
			cacheHint: {},
			// eslint-disable-next-line typescript/no-explicit-any -- mocked loader result
		} as any);

		const result = await runWithContext({ editMode: false, db }, () =>
			getEmDashEntry("post", "approved-slug"),
		);

		expect(getLiveEntry).toHaveBeenCalledTimes(1);
		expect(result.entry?.data.title).toBe("Final title");
	});

	it("retains revision metadata in preview entry results", async () => {
		const [entry] = mockEntries();
		vi.mocked(getLiveEntry).mockResolvedValue({
			entry,
			error: undefined,
			cacheHint: {},
			// eslint-disable-next-line typescript/no-explicit-any -- mocked loader result
		} as any);

		const result = await runWithContext(
			{ editMode: false, preview: { collection: "post", id: "db-1" }, db },
			() => getEmDashEntry("post", "hello"),
		);

		expect(result.isPreview).toBe(true);
		expect(result.entry!.data).toHaveProperty("liveRevisionId", "live-1");
		expect(result.entry!.data).toHaveProperty("draftRevisionId", "draft-1");
	});

	it("retains revision metadata only for the previewed collection entry", async () => {
		const [previewed] = mockEntries();
		const [other] = mockEntries();
		other!.id = "other";
		other!.slug = "other";
		other!.data.id = "db-2";
		vi.mocked(getLiveCollection).mockResolvedValue({
			entries: [previewed, other],
			error: undefined,
			cacheHint: {},
			// eslint-disable-next-line typescript/no-explicit-any -- mocked loader result
		} as any);

		const result = await runWithContext(
			{ editMode: false, preview: { collection: "post", id: "db-1" }, db },
			() => getEmDashCollection("post"),
		);

		expect(result.entries[0]!.data).toHaveProperty("liveRevisionId", "live-1");
		expect(result.entries[0]!.data).toHaveProperty("draftRevisionId", "draft-1");
		expect(result.entries[1]!.data).not.toHaveProperty("liveRevisionId");
		expect(result.entries[1]!.data).not.toHaveProperty("draftRevisionId");
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

	it("reloads new content caches after a legacy publisher invalidates the collection", async () => {
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

		invalidateObjectCache("content:post");
		await flush();

		await runWithContext({ editMode: false, db }, () => getEmDashCollection("post"));
		expect(getLiveCollection).toHaveBeenCalledTimes(2);
	});

	it("invalidates legacy content caches after a current publisher writes", async () => {
		let loads = 0;
		const readLegacy = () =>
			cachedQuery({
				namespace: "content:post",
				key: "legacy-entry",
				load: () => Promise.resolve(++loads),
			});

		expect(await readLegacy()).toBe(1);
		await flush();
		expect(await readLegacy()).toBe(1);

		invalidateCollectionCache("post");
		await flush();

		expect(await readLegacy()).toBe(2);
	});

	it("keeps cached public content after a version-only content update", async () => {
		vi.mocked(getLiveCollection).mockResolvedValue({
			entries: mockEntries(),
			error: undefined,
			cacheHint: {},
			// eslint-disable-next-line typescript/no-explicit-any -- mocked loader result
		} as any);
		const repo = new ContentRepository(db);
		const created = await repo.create(createPostFixture({ slug: "version-only" }));

		await runWithContext({ editMode: false, db }, () => getEmDashCollection("post"));
		await flush();
		await runWithContext({ editMode: false, db }, () => getEmDashCollection("post"));
		expect(getLiveCollection).toHaveBeenCalledTimes(1);

		await repo.update("post", created.id, {});
		await flush();

		await runWithContext({ editMode: false, db }, () => getEmDashCollection("post"));
		expect(getLiveCollection).toHaveBeenCalledTimes(1);
	});

	it("keeps cached public content when a draft revision is staged or discarded", async () => {
		vi.mocked(getLiveCollection).mockResolvedValue({
			entries: mockEntries(),
			error: undefined,
			cacheHint: {},
			// eslint-disable-next-line typescript/no-explicit-any -- mocked loader result
		} as any);
		const repo = new ContentRepository(db);
		const created = await repo.create(createPostFixture({ slug: "draft-pointer" }));
		const draft = await new RevisionRepository(db).create({
			collection: "post",
			entryId: created.id,
			data: { title: "Draft" },
		});

		await runWithContext({ editMode: false, db }, () => getEmDashCollection("post"));
		await flush();

		await repo.setDraftRevision("post", created.id, draft.id);
		await flush();
		await runWithContext({ editMode: false, db }, () => getEmDashCollection("post"));

		await repo.discardDraft("post", created.id);
		await flush();
		await runWithContext({ editMode: false, db }, () => getEmDashCollection("post"));

		expect(getLiveCollection).toHaveBeenCalledTimes(1);
	});

	it("invalidates cached collection content after publication succeeds", async () => {
		vi.mocked(getLiveCollection).mockResolvedValue({
			entries: mockEntries(),
			error: undefined,
			cacheHint: {},
			// eslint-disable-next-line typescript/no-explicit-any -- mocked loader result
		} as any);
		const repo = new ContentRepository(db);
		const created = await repo.create(createPostFixture({ slug: "publish-cache" }));

		await runWithContext({ editMode: false, db }, () => getEmDashCollection("post"));
		await flush();
		await runWithContext({ editMode: false, db }, () => getEmDashCollection("post"));
		expect(getLiveCollection).toHaveBeenCalledTimes(1);

		await repo.publish("post", created.id);
		await flush();
		await runWithContext({ editMode: false, db }, () => getEmDashCollection("post"));

		expect(getLiveCollection).toHaveBeenCalledTimes(2);
	});

	it("keeps cached collection content after a scheduled publication CAS miss", async () => {
		vi.mocked(getLiveCollection).mockResolvedValue({
			entries: mockEntries(),
			error: undefined,
			cacheHint: {},
			// eslint-disable-next-line typescript/no-explicit-any -- mocked loader result
		} as any);
		const repo = new ContentRepository(db);
		const created = await repo.create(createPostFixture({ slug: "missed-publish-cache" }));

		await runWithContext({ editMode: false, db }, () => getEmDashCollection("post"));
		await flush();
		await runWithContext({ editMode: false, db }, () => getEmDashCollection("post"));
		expect(getLiveCollection).toHaveBeenCalledTimes(1);

		await expect(repo.publish("post", created.id, undefined, true)).rejects.toBeInstanceOf(
			ScheduledNotDueError,
		);
		await flush();
		await runWithContext({ editMode: false, db }, () => getEmDashCollection("post"));

		expect(getLiveCollection).toHaveBeenCalledTimes(1);
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
		const second = await runWithContext({ editMode: true, db }, () => getEmDashCollection("post"));
		expect(getLiveCollection).toHaveBeenCalledTimes(2);
		expect(second.entries[0]!.data).toHaveProperty("liveRevisionId", "live-1");
		expect(second.entries[0]!.data).toHaveProperty("draftRevisionId", "draft-1");
	});

	it("invalidates the content cache when a field is created or deleted", async () => {
		const { handleSchemaFieldCreate, handleSchemaFieldDelete } =
			await import("../../src/api/handlers/schema.js");
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

		// A dropped column would otherwise leave stale field values in cached snapshots.
		const del = await handleSchemaFieldDelete(db, "post", "content");
		expect(del.success).toBe(true);
		await flush();
		await runWithContext({ editMode: false, db }, () => getEmDashCollection("post"));
		expect(getLiveCollection).toHaveBeenCalledTimes(2);

		const created = await handleSchemaFieldCreate(db, "post", {
			slug: "subtitle",
			label: "Subtitle",
			type: "string",
		});
		expect(created.success).toBe(true);
		await flush();
		await runWithContext({ editMode: false, db }, () => getEmDashCollection("post"));
		expect(getLiveCollection).toHaveBeenCalledTimes(3);
	});

	it("keeps a due scheduled entry hidden until publication invalidates the cache", async () => {
		const data: Record<string, unknown> = {
			id: "db-due",
			title: "Initial title",
			status: "scheduled",
			scheduledAt: new Date(Date.now() - 60_000),
		};
		vi.mocked(getLiveEntry).mockResolvedValue({
			entry: { id: "due", slug: "initial-slug", status: "scheduled", data, cacheHint: {} },
			error: undefined,
			cacheHint: {},
			// eslint-disable-next-line typescript/no-explicit-any -- mocked loader result
		} as any);

		const first = await runWithContext({ editMode: false, db }, () =>
			getEmDashEntry("post", "initial-slug"),
		);
		await flush();
		const second = await runWithContext({ editMode: false, db }, () =>
			getEmDashEntry("post", "initial-slug"),
		);

		expect(first.entry).toBeNull();
		expect(second.entry).toBeNull();
		expect(getLiveEntry).toHaveBeenCalledTimes(1);
	});
});

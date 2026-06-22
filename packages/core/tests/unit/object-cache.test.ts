import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("virtual:emdash/wait-until", () => ({ waitUntil: undefined }), { virtual: true });

import { decode, encode } from "../../src/object-cache/codec.js";
import {
	__setObjectCacheBackendForTests,
	cachedQuery,
	invalidateObjectCache,
	type ObjectCacheBackend,
} from "../../src/object-cache/index.js";
import { createObjectCache as createMemoryCache } from "../../src/object-cache/memory.js";
import { runWithContext } from "../../src/request-context.js";

/** Flush the microtask + macrotask queue so deferred `after()` writes land. */
async function flush(): Promise<void> {
	await new Promise((r) => setTimeout(r, 0));
}

/** A simple in-memory backend with call spies, isolated per test. */
function spyBackend(): ObjectCacheBackend & { store: Map<string, string> } {
	const store = new Map<string, string>();
	return {
		store,
		get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
		set: vi.fn((key: string, value: string) => {
			store.set(key, value);
			return Promise.resolve();
		}),
		delete: vi.fn((key: string) => {
			store.delete(key);
			return Promise.resolve();
		}),
	};
}

describe("object-cache codec", () => {
	it("round-trips primitives, arrays, and nested objects", () => {
		const value = { a: 1, b: "two", c: [3, 4], d: { e: true, f: null } };
		expect(decode(encode(value))).toEqual(value);
	});

	it("preserves Date instances", () => {
		const value = { createdAt: new Date("2024-01-02T03:04:05.678Z"), nested: { d: new Date(0) } };
		const decoded = decode(encode(value)) as typeof value;
		expect(decoded.createdAt).toBeInstanceOf(Date);
		expect(decoded.createdAt.toISOString()).toBe("2024-01-02T03:04:05.678Z");
		expect(decoded.nested.d).toBeInstanceOf(Date);
	});

	it("drops functions and symbol-keyed properties (not JSON-representable)", () => {
		const sym = Symbol("hidden");
		const value: Record<string, unknown> = { keep: 1, fn: () => 42 };
		Object.defineProperty(value, sym, { value: "x", enumerable: false });
		const decoded = decode(encode(value)) as Record<string, unknown>;
		expect(decoded).toEqual({ keep: 1 });
	});

	it("returns undefined for malformed input (treated as a miss)", () => {
		expect(decode("not json{")).toBeUndefined();
	});

	it("does not collapse a multi-key user object that carries the date tag", () => {
		const value = { meta: { $$emdashDate: "not actually a date marker", other: 1 } };
		expect(decode(encode(value))).toEqual(value);
	});
});

describe("memory backend", () => {
	it("stores and retrieves values", async () => {
		const cache = createMemoryCache({ maxEntries: 10 });
		await cache.set("k", "v");
		expect(await cache.get("k")).toBe("v");
	});

	it("returns null after delete", async () => {
		const cache = createMemoryCache({});
		await cache.set("k", "v");
		await cache.delete("k");
		expect(await cache.get("k")).toBeNull();
	});

	it("expires entries past their TTL", async () => {
		const cache = createMemoryCache({});
		await cache.set("k", "v", 1);
		expect(await cache.get("k")).toBe("v");
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
		expect(await cache.get("k")).toBeNull();
		vi.restoreAllMocks();
	});
});

describe("cachedQuery", () => {
	beforeEach(() => {
		__setObjectCacheBackendForTests(spyBackend(), { revalidate: 1000, defaultTtl: 3600 });
	});
	afterEach(() => {
		__setObjectCacheBackendForTests(null);
	});

	it("passes through to load when no backend is configured", async () => {
		__setObjectCacheBackendForTests(null);
		const load = vi.fn(() => Promise.resolve({ n: 1 }));
		const result = await cachedQuery({ namespace: "t", key: "k", load });
		expect(result).toEqual({ n: 1 });
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("serves the second call from cache without calling load", async () => {
		const load = vi.fn(() => Promise.resolve({ n: Math.random() }));
		const first = await cachedQuery({ namespace: "t", key: "k", load });
		await flush(); // let the deferred set land
		const second = await cachedQuery({ namespace: "t", key: "k", load });
		expect(second).toEqual(first);
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("preserves Date values through the cache round-trip", async () => {
		const load = vi.fn(() => Promise.resolve({ when: new Date("2025-06-01T00:00:00.000Z") }));
		await cachedQuery({ namespace: "t", key: "d", load });
		await flush();
		const hit = await cachedQuery<{ when: Date }>({ namespace: "t", key: "d", load });
		expect(hit.when).toBeInstanceOf(Date);
		expect(hit.when.toISOString()).toBe("2025-06-01T00:00:00.000Z");
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("does not cache values rejected by `cacheable`", async () => {
		const load = vi.fn(() => Promise.resolve({ ok: false }));
		await cachedQuery({ namespace: "t", key: "e", load, cacheable: (v) => v.ok });
		await flush();
		await cachedQuery({ namespace: "t", key: "e", load, cacheable: (v) => v.ok });
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("bypasses the cache in edit mode", async () => {
		const load = vi.fn(() => Promise.resolve({ n: 1 }));
		await runWithContext({ editMode: true }, async () => {
			await cachedQuery({ namespace: "t", key: "k", load });
			await cachedQuery({ namespace: "t", key: "k", load });
		});
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("bypasses the cache for preview requests", async () => {
		const load = vi.fn(() => Promise.resolve({ n: 1 }));
		await runWithContext(
			{ editMode: false, preview: { collection: "posts", id: "1" } },
			async () => {
				await cachedQuery({ namespace: "t", key: "k", load });
				await cachedQuery({ namespace: "t", key: "k", load });
			},
		);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("reloads after the namespace is invalidated", async () => {
		const load = vi.fn(() => Promise.resolve({ n: Math.random() }));
		await cachedQuery({ namespace: "posts", key: "k", load });
		await flush();
		await cachedQuery({ namespace: "posts", key: "k", load });
		expect(load).toHaveBeenCalledTimes(1);

		invalidateObjectCache("posts");
		await flush();

		await cachedQuery({ namespace: "posts", key: "k", load });
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("invalidates when any namespace in a multi-namespace key is bumped", async () => {
		const load = vi.fn(() => Promise.resolve({ n: Math.random() }));
		const ns = ["content:posts", "bylines", "taxonomies"];
		await cachedQuery({ namespace: ns, key: "k", load });
		await flush();
		await cachedQuery({ namespace: ns, key: "k", load });
		expect(load).toHaveBeenCalledTimes(1);

		// Bump only the shared bylines namespace.
		invalidateObjectCache("bylines");
		await flush();

		await cachedQuery({ namespace: ns, key: "k", load });
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("does not let a stale in-flight epoch read clobber a concurrent invalidation", async () => {
		// An epoch read started before an invalidation must not, on resolving with
		// the pre-bump backend value, lower the freshly-bumped local epoch — that
		// would resurrect the values the invalidation just orphaned.
		const store = new Map<string, string>();
		let releaseEpoch: ((v: string | null) => void) | undefined;
		let gate = false;
		const backend: ObjectCacheBackend = {
			get: (key) => {
				if (gate && key.includes(":epoch:")) {
					return new Promise<string | null>((resolve) => {
						releaseEpoch = resolve;
					});
				}
				return Promise.resolve(store.get(key) ?? null);
			},
			set: (key, value) => {
				store.set(key, value);
				return Promise.resolve();
			},
			delete: (key) => {
				store.delete(key);
				return Promise.resolve();
			},
		};
		__setObjectCacheBackendForTests(backend, { revalidate: 0, defaultTtl: 3600 });

		const load = vi.fn(() => Promise.resolve({ n: Math.random() }));

		// Prime: value stored under epoch 0.
		const primed = await cachedQuery({ namespace: "posts", key: "k", load });
		await flush();

		// Start a query whose epoch read parks in flight.
		gate = true;
		const inflight = cachedQuery({ namespace: "posts", key: "k", load });
		await flush();

		// Invalidate mid-flight: bumps the local epoch above 0.
		invalidateObjectCache("posts");

		// The parked epoch read now resolves with the stale backend epoch.
		releaseEpoch?.(null);
		const inflightResult = await inflight;
		await flush();

		// The bump must survive: the in-flight query reloads rather than serving
		// the pre-invalidation value.
		expect(inflightResult).not.toEqual(primed);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("captures epochs before load even when the value read fails", async () => {
		// When the value read errors, the epochs must still be captured *before*
		// load() runs. Re-reading them afterwards would pick up a write that
		// landed mid-load and stamp the stale value under the new epoch, so a
		// later read would serve it as a HIT.
		const store = new Map<string, string>();
		let failValueGet = true;
		let releaseLoad: (() => void) | undefined;
		const backend: ObjectCacheBackend = {
			get: (key) => {
				if (key.includes(":epoch:")) return Promise.resolve(store.get(key) ?? null);
				if (failValueGet) return Promise.reject(new Error("value get down"));
				return Promise.resolve(store.get(key) ?? null);
			},
			set: (key, value) => {
				store.set(key, value);
				return Promise.resolve();
			},
			delete: (key) => {
				store.delete(key);
				return Promise.resolve();
			},
		};
		__setObjectCacheBackendForTests(backend, { revalidate: 0, defaultTtl: 3600 });

		let n = 0;
		let parkFirst = true;
		const load = vi.fn(() => {
			const v = ++n;
			if (parkFirst) {
				parkFirst = false;
				return new Promise<{ n: number }>((resolve) => {
					releaseLoad = () => resolve({ n: v });
				});
			}
			return Promise.resolve({ n: v });
		});

		// Value read rejects → load path. Hold load open.
		const q1 = cachedQuery<{ n: number }>({ namespace: "posts", key: "k", load });
		await flush();

		// A write invalidates the namespace while load is in flight.
		invalidateObjectCache("posts");
		await flush();

		releaseLoad?.();
		const first = await q1;
		await flush();

		// Value reads work again; the value cached during the load must have been
		// stamped with the pre-load epoch, so the bump orphans it and we reload.
		failValueGet = false;
		const second = await cachedQuery<{ n: number }>({ namespace: "posts", key: "k", load });
		expect(second).not.toEqual(first);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("treats a backend read error as a miss without throwing", async () => {
		const backend = spyBackend();
		backend.get = vi.fn(() => Promise.reject(new Error("kv down")));
		__setObjectCacheBackendForTests(backend, { revalidate: 1000, defaultTtl: 3600 });
		const load = vi.fn(() => Promise.resolve({ n: 1 }));
		const result = await cachedQuery({ namespace: "t", key: "k", load });
		expect(result).toEqual({ n: 1 });
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("does not hang when a backend read never settles — times out to a miss", async () => {
		// A backend.get that never resolves or rejects (the production hang:
		// a stalled KV read). With a short timeout the query must still settle.
		const backend = spyBackend();
		backend.get = vi.fn(() => new Promise<string | null>(() => {})); // never settles
		__setObjectCacheBackendForTests(backend, { revalidate: 1000, defaultTtl: 3600, timeout: 20 });
		const load = vi.fn(() => Promise.resolve({ n: 1 }));

		const result = await cachedQuery({ namespace: "t", key: "k", load });
		expect(result).toEqual({ n: 1 });
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("self-heals after a stalled read instead of poisoning the namespace", async () => {
		// First the backend stalls (epoch + value reads hang); after the timeout
		// the namespace must recover and serve from cache on a healthy backend.
		const store = new Map<string, string>();
		let healthy = false;
		const backend: ObjectCacheBackend = {
			get: (key) =>
				healthy ? Promise.resolve(store.get(key) ?? null) : new Promise<string | null>(() => {}), // stalls while unhealthy
			set: (key, value) => {
				store.set(key, value);
				return Promise.resolve();
			},
			delete: (key) => {
				store.delete(key);
				return Promise.resolve();
			},
		};
		__setObjectCacheBackendForTests(backend, { revalidate: 0, defaultTtl: 3600, timeout: 20 });

		const load = vi.fn(() => Promise.resolve({ n: 1 }));

		// While stalled: degrades to load() instead of hanging.
		await expect(cachedQuery({ namespace: "posts", key: "k", load })).resolves.toEqual({ n: 1 });

		// Backend recovers; the stuck epoch promise must have settled (timed out)
		// and been replaced, so the namespace is usable again.
		healthy = true;
		await flush();
		await cachedQuery({ namespace: "posts", key: "k", load });
		await flush();
		const calls = load.mock.calls.length;
		await cachedQuery({ namespace: "posts", key: "k", load });
		// The second post-recovery call is served from cache (load not re-run).
		expect(load.mock.calls.length).toBe(calls);
	});
});

import { describe, expect, it } from "vitest";

import {
	createSingleFlightCache,
	invalidateSingleFlightCache,
	singleFlightCached,
} from "../../../src/utils/single-flight-cache.js";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A promise that never settles — simulates a fetch whose owning request
 * context was torn down mid-await (workerd cancels the continuation, so
 * neither `then` nor `finally` ever runs). This is the production poisoning
 * scenario. */
function neverSettles<T>(): Promise<T> {
	return new Promise<T>(() => {});
}

describe("singleFlightCached", () => {
	it("caches the resolved value across calls (one fetch)", async () => {
		const cache = createSingleFlightCache<number>();
		let calls = 0;
		const fetch = async () => {
			calls++;
			return 5;
		};
		expect(await singleFlightCached(cache, fetch, { pollMs: 10 })).toBe(5);
		expect(await singleFlightCached(cache, fetch, { pollMs: 10 })).toBe(5);
		expect(calls).toBe(1);
	});

	it("caches a void/undefined result so it is not treated as a miss", async () => {
		// The reason the cache stores a boxed value + presence flag rather
		// than relying on a null check: a falsy/void result must still count
		// as cached. Without the box this would refetch every call.
		const cache = createSingleFlightCache<void>();
		let calls = 0;
		const fetch = async () => {
			calls++;
		};
		await singleFlightCached(cache, fetch, { pollMs: 10 });
		await singleFlightCached(cache, fetch, { pollMs: 10 });
		expect(calls).toBe(1);
	});

	it("coalesces concurrent callers into a single fetch", async () => {
		const cache = createSingleFlightCache<number>();
		let calls = 0;
		const fetch = async () => {
			calls++;
			await sleep(30);
			return 7;
		};
		const results = await Promise.all(
			Array.from({ length: 5 }, () => singleFlightCached(cache, fetch, { pollMs: 5 })),
		);
		expect(results).toEqual([7, 7, 7, 7, 7]);
		expect(calls).toBe(1);
	});

	it("invalidateSingleFlightCache forces a refetch", async () => {
		const cache = createSingleFlightCache<number>();
		let n = 0;
		const fetch = async () => ++n;
		expect(await singleFlightCached(cache, fetch, { pollMs: 10 })).toBe(1);
		expect(await singleFlightCached(cache, fetch, { pollMs: 10 })).toBe(1);
		invalidateSingleFlightCache(cache);
		expect(await singleFlightCached(cache, fetch, { pollMs: 10 })).toBe(2);
	});

	it("a stranded owner fetch does not poison later callers", async () => {
		// The whole point of the rewrite. First caller claims, then its
		// fetch never settles (cancelled request). With the old "cache the
		// in-flight promise" approach every later caller awaited that dead
		// promise forever. Here later callers poll a value, reclaim the stale
		// lock after the deadline, and succeed.
		const cache = createSingleFlightCache<string>();

		void singleFlightCached(cache, () => neverSettles<string>(), {
			deadlineMs: 100,
			pollMs: 10,
		});
		expect(cache.lock.ownerStartedAt).not.toBeNull();

		await sleep(120);

		const result = await singleFlightCached(cache, async () => "recovered", {
			deadlineMs: 100,
			pollMs: 10,
			maxWaitMs: 1000,
		});
		expect(result).toBe("recovered");
	});

	it("rejects the owner at ownerTimeoutMs instead of hanging forever", async () => {
		const cache = createSingleFlightCache<string>();
		await expect(
			singleFlightCached(cache, () => neverSettles<string>(), {
				ownerTimeoutMs: 50,
				deadlineMs: 60_000, // high so reclaim doesn't mask the owner timeout
				pollMs: 10,
			}),
		).rejects.toThrow(/exceeded/i);
	});

	it("anchored fetch still publishes for a later caller after the owner times out", async () => {
		// A slow-but-live fetch: the owner gives up at ownerTimeoutMs, but the
		// anchored copy keeps running and populates the cache, so the next
		// caller is served without refetching.
		const cache = createSingleFlightCache<string>();
		let release!: (value: string) => void;
		const slow = new Promise<string>((resolve) => {
			release = resolve;
		});
		const anchored: Promise<void>[] = [];

		await expect(
			singleFlightCached(cache, () => slow, {
				ownerTimeoutMs: 50,
				deadlineMs: 60_000,
				pollMs: 10,
				anchor: (promise) => anchored.push(promise),
			}),
		).rejects.toThrow(/exceeded/i);

		release("late-value");
		await Promise.all(anchored);

		let calls = 0;
		const result = await singleFlightCached(
			cache,
			async () => {
				calls++;
				return "fresh";
			},
			{ pollMs: 10 },
		);
		expect(result).toBe("late-value");
		expect(calls).toBe(0);
	});

	it("keeps the reclaim deadline above ownerTimeoutMs so a slow-but-live owner is not superseded", async () => {
		// A deadlineMs smaller than ownerTimeoutMs, left unguarded, would let a
		// waiter reclaim before the owner finishes — a self-sustaining stampede
		// that never populates the cache. The helper must raise the effective
		// deadline above the owner timeout.
		const cache = createSingleFlightCache<string>();
		let calls = 0;
		const fetch = async () => {
			calls++;
			await sleep(150);
			return "v";
		};
		const opts = { deadlineMs: 30, ownerTimeoutMs: 1000, pollMs: 10, maxWaitMs: 5000 };
		const a = singleFlightCached(cache, fetch, opts);
		await sleep(20);
		const b = singleFlightCached(cache, fetch, opts);
		expect(await a).toBe("v");
		expect(await b).toBe("v");
		expect(calls).toBe(1);
	});

	it("invalidation frees the lock so a fresh reader doesn't wait out a stale owner", async () => {
		const cache = createSingleFlightCache<string>();
		// A slow/stuck in-flight owner holds the lock.
		void singleFlightCached(cache, () => neverSettles<string>(), {
			deadlineMs: 10_000,
			pollMs: 10,
		});
		expect(cache.lock.ownerStartedAt).not.toBeNull();

		invalidateSingleFlightCache(cache);
		expect(cache.lock.ownerStartedAt).toBeNull();

		// maxWaitMs (200) is far below deadlineMs (10s): without the lock being
		// freed, the fresh reader would give up before it could ever reclaim.
		const result = await singleFlightCached(cache, async () => "fresh", {
			deadlineMs: 10_000,
			pollMs: 10,
			maxWaitMs: 200,
		});
		expect(result).toBe("fresh");
	});

	it("ignores a non-positive ownerTimeoutMs instead of rejecting instantly", async () => {
		const cache = createSingleFlightCache<string>();
		const result = await singleFlightCached(cache, async () => "v", {
			ownerTimeoutMs: 0,
			pollMs: 10,
		});
		expect(result).toBe("v");
	});

	it("propagates a fetch rejection to the caller and lets the next caller retry", async () => {
		const cache = createSingleFlightCache<string>();
		await expect(
			singleFlightCached(cache, () => Promise.reject(new Error("boom")), { pollMs: 10 }),
		).rejects.toThrow("boom");
		expect(cache.lock.ownerStartedAt).toBeNull();

		const result = await singleFlightCached(cache, async () => "ok", { pollMs: 10 });
		expect(result).toBe("ok");
	});
});

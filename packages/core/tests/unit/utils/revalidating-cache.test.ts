import { afterEach, describe, expect, it, vi } from "vitest";

import { waitForDeferredTasks } from "../../../src/deferred-tasks.js";
import {
	createRevalidatingCache,
	invalidateRevalidatingCache,
	revalidatingCached,
} from "../../../src/utils/revalidating-cache.js";

const ttl = 30_000;

describe("revalidating cache", () => {
	afterEach(() => vi.useRealTimers());

	it("coalesces cold loads", async () => {
		let calls = 0;
		const cache = createRevalidatingCache<number>();
		const load = async () => ++calls;
		expect(
			await Promise.all([
				revalidatingCached(cache, load, vi.fn()),
				revalidatingCached(cache, load, vi.fn()),
			]),
		).toEqual([1, 1]);
		expect(calls).toBe(1);
	});

	it("reuses warm values", async () => {
		let calls = 0;
		const cache = createRevalidatingCache<number>();
		const load = async () => ++calls;
		expect(await revalidatingCached(cache, load, vi.fn())).toBe(1);
		expect(await revalidatingCached(cache, load, vi.fn())).toBe(1);
		expect(calls).toBe(1);
	});

	it("returns expired values without waiting for refresh", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		let resolve!: (value: number) => void;
		let calls = 0;
		const cache = createRevalidatingCache<number>();
		const load = async () => {
			calls++;
			if (calls === 2) return new Promise<number>((r) => (resolve = r));
			return calls;
		};
		expect(await revalidatingCached(cache, load, vi.fn())).toBe(1);
		vi.setSystemTime(Date.now() + ttl);
		const started = revalidatingCached(cache, load, vi.fn());
		await Promise.resolve();
		await Promise.resolve();
		await expect(started).resolves.toBe(1);
		expect(calls).toBe(2);
		expect(await revalidatingCached(cache, load, vi.fn())).toBe(1);
		expect(calls).toBe(2);
		resolve(2);
		await new Promise((r) => setTimeout(r, 0));
		await waitForDeferredTasks();
		expect(await revalidatingCached(cache, load, vi.fn())).toBe(2);
	});

	it("retains a last-good value and retries a failed refresh", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		let calls = 0;
		const errors: unknown[] = [];
		const cache = createRevalidatingCache<number>();
		const load = async () => {
			calls++;
			if (calls === 2) throw new Error("nope");
			return calls;
		};
		expect(await revalidatingCached(cache, load, (e) => errors.push(e))).toBe(1);
		vi.setSystemTime(Date.now() + ttl);
		expect(await revalidatingCached(cache, load, (e) => errors.push(e))).toBe(1);
		await waitForDeferredTasks();
		expect(errors).toHaveLength(1);
		expect(await revalidatingCached(cache, load, vi.fn())).toBe(1);
		expect(calls).toBe(2);
		vi.setSystemTime(Date.now() + ttl);
		expect(await revalidatingCached(cache, load, (e) => errors.push(e))).toBe(1);
		await waitForDeferredTasks();
		expect(await revalidatingCached(cache, load, vi.fn())).toBe(3);
	});

	it("reloads immediately after invalidation", async () => {
		const cache = createRevalidatingCache<number>();
		expect(await revalidatingCached(cache, async () => 1, vi.fn())).toBe(1);
		invalidateRevalidatingCache(cache);
		expect(await revalidatingCached(cache, async () => 2, vi.fn())).toBe(2);
	});
	it("does not reinstall a background value superseded by invalidation", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const cache = createRevalidatingCache<number>();
		await revalidatingCached(cache, async () => 1, vi.fn());
		vi.setSystemTime(Date.now() + ttl);
		let resolve!: (value: number) => void;
		let started!: () => void;
		const ready = new Promise<void>((done) => {
			started = done;
		});
		const pending = new Promise<number>((done) => {
			resolve = done;
		});
		expect(
			await revalidatingCached(
				cache,
				() => {
					started();
					return pending;
				},
				vi.fn(),
			),
		).toBe(1);
		await ready;
		invalidateRevalidatingCache(cache);
		expect(await revalidatingCached(cache, async () => 3, vi.fn())).toBe(3);
		resolve(2);
		await waitForDeferredTasks();
		expect(await revalidatingCached(cache, async () => 4, vi.fn())).toBe(3);
	});

	it("does not install an invalidated cold load", async () => {
		const cache = createRevalidatingCache<number>();
		let resolve!: (value: number) => void;
		let started!: () => void;
		const ready = new Promise<void>((done) => {
			started = done;
		});
		const pending = new Promise<number>((done) => {
			resolve = done;
		});
		const first = revalidatingCached(
			cache,
			() => {
				started();
				return pending;
			},
			vi.fn(),
		);
		await ready;
		invalidateRevalidatingCache(cache);
		expect(await revalidatingCached(cache, async () => 2, vi.fn())).toBe(2);
		resolve(1);
		expect(await first).toBe(2);
		await waitForDeferredTasks();
		expect(await revalidatingCached(cache, async () => 3, vi.fn())).toBe(2);
	});
});

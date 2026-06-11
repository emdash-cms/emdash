import { describe, expect, it } from "vitest";

import { createInitLock, initWithLock } from "../../../src/utils/init-lock.js";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A promise that never settles — simulates an init whose owning request
 * context was torn down mid-await (workerd cancels the continuation, so
 * neither `then` nor `finally` ever runs). */
function neverSettles<T>(): Promise<T> {
	return new Promise<T>(() => {});
}

describe("initWithLock", () => {
	it("returns the cached value without calling init", async () => {
		const lock = createInitLock();
		let initCalls = 0;
		const result = await initWithLock(
			lock,
			() => "cached",
			async () => {
				initCalls++;
				return "fresh";
			},
		);
		expect(result).toBe("cached");
		expect(initCalls).toBe(0);
	});

	it("runs init once and shares the result with concurrent waiters", async () => {
		const lock = createInitLock();
		let cache: string | null = null;
		let initCalls = 0;
		const init = async () => {
			initCalls++;
			await sleep(50);
			cache = "value";
			return "value";
		};
		const opts = { pollMs: 10 };
		const results = await Promise.all(
			Array.from({ length: 5 }, () => initWithLock(lock, () => cache, init, opts)),
		);
		expect(results).toEqual(["value", "value", "value", "value", "value"]);
		expect(initCalls).toBe(1);
	});

	it("reclaims the lock after the deadline when the owner is abandoned", async () => {
		const lock = createInitLock();
		let cache: string | null = null;

		// First caller claims the lock, then its continuation dies: init never
		// settles, so the post-await cleanup never runs and the lock looks
		// held forever. This is the poisoned-isolate scenario from production.
		void initWithLock(
			lock,
			() => cache,
			() => neverSettles<string>(),
			{
				deadlineMs: 100,
				pollMs: 10,
			},
		);
		expect(lock.ownerStartedAt).not.toBeNull();

		await sleep(120);

		// A later request must reclaim the stale lock and initialize.
		const result = await initWithLock(
			lock,
			() => cache,
			async () => {
				cache = "recovered";
				return "recovered";
			},
			{ deadlineMs: 100, pollMs: 10, maxWaitMs: 1000 },
		);
		expect(result).toBe("recovered");
	});

	it("releases the lock when init throws so the next caller can retry", async () => {
		const lock = createInitLock();
		let cache: string | null = null;

		await expect(
			initWithLock(
				lock,
				() => cache,
				() => Promise.reject(new Error("boom")),
				{ pollMs: 10 },
			),
		).rejects.toThrow("boom");
		expect(lock.ownerStartedAt).toBeNull();

		const result = await initWithLock(
			lock,
			() => cache,
			async () => {
				cache = "ok";
				return "ok";
			},
			{ pollMs: 10 },
		);
		expect(result).toBe("ok");
	});

	it("gives up after maxWaitMs instead of waiting forever", async () => {
		const lock = createInitLock();

		void initWithLock(
			lock,
			() => null,
			() => neverSettles<string>(),
			{
				deadlineMs: 60_000,
				pollMs: 10,
			},
		);

		await expect(
			initWithLock(
				lock,
				() => null,
				async () => "late",
				{
					deadlineMs: 60_000,
					pollMs: 10,
					maxWaitMs: 100,
				},
			),
		).rejects.toThrow(/timed out/i);
	});

	it("lets a waiter pick up a value cached by the owner mid-wait", async () => {
		const lock = createInitLock();
		let cache: string | null = null;

		const owner = initWithLock(
			lock,
			() => cache,
			async () => {
				await sleep(40);
				cache = "owner-value";
				return "owner-value";
			},
			{ pollMs: 10 },
		);
		await sleep(5);
		const waiter = initWithLock(
			lock,
			() => cache,
			async () => "waiter-value",
			{ pollMs: 10, maxWaitMs: 1000 },
		);
		expect(await owner).toBe("owner-value");
		expect(await waiter).toBe("owner-value");
	});
});

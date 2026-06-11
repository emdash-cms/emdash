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

	it("reclaims from a live-but-slow owner without running init more than twice", async () => {
		// The dangerous path for deadline tuning: the owner is healthy but
		// slower than deadlineMs (e.g. contended migrations). A waiter
		// reclaims and runs a second init; both must resolve, init must run
		// at most twice, and the cache must converge.
		const lock = createInitLock();
		let cache: string | null = null;
		let initCalls = 0;

		const owner = initWithLock(
			lock,
			() => cache,
			async () => {
				initCalls++;
				await sleep(250);
				cache = "slow-owner";
				return "slow-owner";
			},
			{ deadlineMs: 100, pollMs: 10, maxWaitMs: 2000 },
		);
		await sleep(10);
		const waiter = initWithLock(
			lock,
			() => cache,
			async () => {
				initCalls++;
				cache = "reclaimer";
				return "reclaimer";
			},
			{ deadlineMs: 100, pollMs: 10, maxWaitMs: 2000 },
		);

		expect(await owner).toBe("slow-owner");
		expect(await waiter).toBe("reclaimer");
		expect(initCalls).toBe(2);

		// Cache has converged: later callers are served from it, no third init.
		const third = await initWithLock(
			lock,
			() => cache,
			async () => {
				initCalls++;
				return "third";
			},
			{ deadlineMs: 100, pollMs: 10 },
		);
		expect(third).toBe(cache);
		expect(initCalls).toBe(2);
	});

	it("does not let a finished stale owner release the reclaimer's lock", async () => {
		// The clobber race: owner A is slow and eventually FAILS (so it never
		// populates the cache), waiter B reclaims at the deadline, then A's
		// cleanup runs while B is still mid-init. A must not release B's
		// claim — if it does, a third caller C arriving in that window
		// claims the lock and starts a third concurrent init.
		const lock = createInitLock();
		let cache: string | null = null;
		let initCalls = 0;
		const opts = { deadlineMs: 300, pollMs: 20, maxWaitMs: 3000 };

		// A: claims at t=0, rejects at t≈400 (after B reclaimed at t≈300+).
		const ownerA = initWithLock(
			lock,
			() => cache,
			async () => {
				initCalls++;
				await sleep(400);
				throw new Error("slow failure");
			},
			opts,
		).catch((error: unknown) => error);

		// B: arrives early, reclaims at t≈300-340, succeeds at t≈520-540.
		await sleep(20);
		const reclaimerB = initWithLock(
			lock,
			() => cache,
			async () => {
				initCalls++;
				await sleep(200);
				cache = "reclaimer";
				return "reclaimer";
			},
			opts,
		);

		// C: arrives at t≈440 — after A's cleanup ran, while B is mid-init.
		// C must wait for B's result, not start a third init.
		await sleep(420);
		const lateC = initWithLock(
			lock,
			() => cache,
			async () => {
				initCalls++;
				cache = "late";
				return "late";
			},
			opts,
		);

		expect(await reclaimerB).toBe("reclaimer");
		expect(await lateC).toBe("reclaimer");
		expect(await ownerA).toBeInstanceOf(Error);
		expect(initCalls).toBe(2);
	});

	it("anchors the in-flight init promise and swallows its rejection", async () => {
		const lock = createInitLock();
		const anchored: Promise<void>[] = [];

		await expect(
			initWithLock(
				lock,
				() => null,
				() => Promise.reject(new Error("boom")),
				{
					pollMs: 10,
					anchor: (promise) => anchored.push(promise),
				},
			),
		).rejects.toThrow("boom");

		expect(anchored).toHaveLength(1);
		// The anchored copy must never reject (it goes to waitUntil, where a
		// rejection would surface as an unhandled error in the host).
		await expect(anchored[0]).resolves.toBeUndefined();
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

/**
 * `wrapAtcuteSubscription` regression test.
 *
 * The wrapper's `close()` MUST cancel a pending `for await` even when the
 * underlying subscription is quiescent (no events arriving). MockJetstream
 * actively resolves pending awaiters on close, so it can't catch a
 * misbehaving production wrapper — this test pairs the wrapper with a stub
 * whose `next()` never resolves, and asserts the for-await terminates within
 * a small grace window after `close()`.
 *
 * Without the fix, the wrapper's `close()` flipped a flag the iterator only
 * checked AFTER `inner.next()` resolved, so a quiescent stream would hang
 * `stop()` indefinitely. This test failing means we've regressed there.
 */

import { describe, expect, it } from "vitest";

import { wrapAtcuteSubscription, type RawJetstreamSubscription } from "../src/jetstream-client.js";

interface QuiescentEvent {
	kind: string;
}

/**
 * Subscription stub whose `next()` returns a Promise that NEVER resolves,
 * even after `return()` is called. This mirrors `@mary-ext/event-iterator`'s
 * actual behaviour: `EventIterator.return()` drops its resolver reference
 * without invoking it (`lib/index.ts:55-67`), so a pending `next()` Promise
 * is orphaned. If the wrapper relies on `inner.return()` resolving the
 * pending await (the C1 mistake), this stub catches it — the for-await
 * never wakes from `inner.return()` alone, only the closed-signal race in
 * the wrapper can unblock it.
 */
function quiescentSubscription(): RawJetstreamSubscription<QuiescentEvent> {
	let returned = false;
	const innerIter: AsyncIterator<QuiescentEvent> = {
		next() {
			if (returned) return Promise.resolve({ value: undefined, done: true });
			// Return a Promise that never settles. Mirrors EventIterator's
			// behaviour: it stashes the resolver in a private field and
			// drops it on return() without ever calling it.
			return new Promise<IteratorResult<QuiescentEvent>>(() => {});
		},
		async return() {
			returned = true;
			return { value: undefined, done: true };
		},
	};
	return {
		cursor: 0,
		[Symbol.asyncIterator]: () => innerIter,
	};
}

describe("wrapAtcuteSubscription", () => {
	it("close() unblocks a for-await waiting on a quiescent subscription", async () => {
		const sub = quiescentSubscription();
		const handle = wrapAtcuteSubscription(sub);

		// Start consuming on a background promise. The for-await will block
		// on the first iter.next() because the underlying inner iterator
		// only resolves when return() is called.
		const consumed: QuiescentEvent[] = [];
		const consumePromise = (async () => {
			for await (const event of handle) {
				consumed.push(event);
			}
		})();

		// Yield a few microtasks so the consumer reaches the awaiting state.
		await Promise.resolve();
		await Promise.resolve();
		await new Promise<void>((r) => setTimeout(r, 0));

		// The consumer should be wedged, not done. Use Promise.race to
		// detect — if it's wedged, the timeout wins.
		const beforeClose = await Promise.race([
			consumePromise.then(() => "done" as const),
			new Promise<"pending">((r) => setTimeout(r, 10, "pending")),
		]);
		expect(beforeClose).toBe("pending");

		// close() must cancel the pending await.
		handle.close();

		// Now the consumer should resolve quickly.
		await expect(
			Promise.race([
				consumePromise.then(() => "done" as const),
				new Promise<"timeout">((r) => setTimeout(r, 100, "timeout")),
			]),
		).resolves.toBe("done");

		expect(consumed).toEqual([]);
	});

	it("filters non-commit events", async () => {
		const events: Array<{ kind: string; commit?: { collection: string } }> = [
			{ kind: "identity" },
			{ kind: "commit", commit: { collection: "x" } },
			{ kind: "account" },
			{ kind: "commit", commit: { collection: "y" } },
		];
		let i = 0;
		const sub: RawJetstreamSubscription<(typeof events)[number]> = {
			cursor: 0,
			[Symbol.asyncIterator]: () => ({
				async next() {
					if (i >= events.length) return { value: undefined, done: true };
					const value = events[i++];
					return { value: value as (typeof events)[number], done: false };
				},
			}),
		};
		const handle = wrapAtcuteSubscription(sub);
		const out: unknown[] = [];
		for await (const event of handle) out.push(event);
		expect(out).toHaveLength(2);
		expect(out.every((e) => (e as { kind: string }).kind === "commit")).toBe(true);
	});
});

/**
 * Global-scope async value cache with single-flight and poison-immunity.
 *
 * Built for the "compute once for the lifetime of the JS global scope, read
 * on every request" caches (site settings, search-health verification, ...).
 * That global scope is the process on Node and the isolate on Cloudflare
 * Workers — this helper is platform-neutral; the hazard it defends against is
 * specific to workerd but the cache itself is not.
 *
 * These caches must coalesce concurrent cold reads into one query — but the
 * obvious way to do that, caching the in-flight *promise* on a global and
 * awaiting it from later requests, is unsafe on workerd: if the request that
 * created the promise is cancelled mid-await (client disconnect, context
 * teardown), its continuation never runs, so the promise neither resolves nor
 * rejects. Every later request that awaits that shared promise then hangs
 * until the isolate is evicted (observed as 524s at the 100s wall, near-zero
 * CPU). A `.catch`/`.finally` that clears the cache doesn't help — a cancelled
 * request settles neither way.
 *
 * This cache stores the resolved *value* (not a promise) and coalesces via
 * `initWithLock`: one request becomes the owner and runs `fetch`, everyone
 * else polls for the published value and never awaits the owner's promise.
 * A cancelled owner can therefore never strand a waiter — the worst case is
 * the lock looks held until `deadlineMs`, then the next caller reclaims. The
 * owner's `fetch` is also anchored (waitUntil) so a cancelled originator's
 * query still completes and populates the cache, and bounded by
 * `ownerTimeoutMs` so a genuinely stuck fetch reclaims instead of hanging.
 *
 * Invalidation bumps `version`; reads compare against the version captured at
 * call time and refetch on mismatch.
 */

import { createInitLock, type InitLock, initWithLock } from "./init-lock.js";

export interface SingleFlightCache<T> {
	/** Last resolved value, valid only when `hasValue` is true. */
	value: T | null;
	/**
	 * Presence flag, separate from `value` so that falsy/`undefined`/`void`
	 * results cache correctly (a plain null check can't distinguish "cached
	 * undefined" from "never fetched").
	 */
	hasValue: boolean;
	/** Invalidation counter; bumped by `invalidateSingleFlightCache`. */
	version: number;
	/** The `version` the cached value was fetched at. */
	valueVersion: number;
	/** Reclaimable single-flight lock (see init-lock.ts). */
	lock: InitLock;
}

export function createSingleFlightCache<T>(): SingleFlightCache<T> {
	return { value: null, hasValue: false, version: 0, valueVersion: -1, lock: createInitLock() };
}

/**
 * Force the next `singleFlightCached` call to refetch. An in-flight owner
 * fetched at the old version will not publish into the new version, so its
 * result is ignored by subsequent reads.
 */
export function invalidateSingleFlightCache(cache: SingleFlightCache<unknown>): void {
	cache.version++;
	cache.hasValue = false;
	cache.value = null;
	cache.valueVersion = -1;
	// Free the single-flight lock so a reader at the new version starts the
	// refetch immediately instead of waiting out a stale owner's deadline. A
	// still-running old-version owner can neither publish into the new version
	// (version gate) nor clobber a new owner (claim gate), so releasing here
	// is safe; the worst case is one brief duplicate fetch.
	cache.lock.ownerStartedAt = null;
}

/**
 * Headroom between the owner's own timeout and the waiter reclaim deadline.
 * The reclaim deadline must sit *above* `ownerTimeoutMs` so a slow-but-live
 * owner times out (and releases the lock) before a waiter would reclaim it —
 * otherwise a fetch slower than the deadline is superseded before it can
 * publish, and steady traffic turns that into a self-sustaining stampede.
 */
const RECLAIM_HEADROOM_MS = 5_000;

export interface SingleFlightCachedOptions {
	/**
	 * Hand the in-flight fetch to the host's lifetime extender (waitUntil via
	 * `after()`), so a cancelled originating request still drives it to
	 * completion and populates the cache.
	 */
	anchor?: (promise: Promise<void>) => void;
	/** Reclaim the single-flight lock if the owner holds it past this. */
	deadlineMs?: number;
	/** Waiter poll interval. */
	pollMs?: number;
	/** Waiter gives up and throws after this long rather than hanging. */
	maxWaitMs?: number;
	/**
	 * Bound the owner's own `fetch`: if it doesn't settle within this, the
	 * owner rejects (and releases the lock) instead of waiting indefinitely.
	 * The anchored copy keeps running, so a slow-but-live fetch can still
	 * publish for a later caller. Omit to leave the owner unbounded.
	 */
	ownerTimeoutMs?: number;
}

/** Boxed cache hit so a `void`/falsy value is still distinguishable from a miss. */
interface Box<T> {
	v: T;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`singleFlightCached: owner fetch exceeded ${ms}ms`));
		}, ms);
		// Settle from the underlying promise (whichever wins the race with the
		// timer), and always clear the timer so a resolved fetch doesn't leave
		// a pending timeout holding the isolate alive.
		promise.then(resolve, reject).finally(() => {
			clearTimeout(timer);
		});
	});
}

/**
 * Return the cached value for `cache`, computing it via `fetch` under a
 * single-flight lock on a miss. Concurrent callers coalesce onto one fetch;
 * a cancelled owner cannot poison later callers (see file header).
 */
export function singleFlightCached<T>(
	cache: SingleFlightCache<T>,
	fetch: () => Promise<T>,
	options: SingleFlightCachedOptions = {},
): Promise<T> {
	// Capture the version once: a value published at this version satisfies
	// this call; an invalidation that lands mid-fetch makes the published
	// value stale for *later* calls (which captured the newer version) but
	// still valid for this one.
	const versionAtCall = cache.version;

	// Ignore a non-positive / non-finite owner timeout rather than letting it
	// degenerate into an instant-reject (setTimeout coerces NaN/0 to ~0ms).
	const ownerTimeoutMs =
		options.ownerTimeoutMs !== undefined &&
		Number.isFinite(options.ownerTimeoutMs) &&
		options.ownerTimeoutMs > 0
			? options.ownerTimeoutMs
			: undefined;

	// Keep the reclaim deadline above the owner timeout (see RECLAIM_HEADROOM_MS):
	// the owner's own timeout, not a waiter reclaim, is the primary release.
	const deadlineMs =
		ownerTimeoutMs === undefined
			? options.deadlineMs
			: Math.max(options.deadlineMs ?? 0, ownerTimeoutMs + RECLAIM_HEADROOM_MS);

	return initWithLock<Box<T>>(
		cache.lock,
		() =>
			cache.hasValue && cache.valueVersion === versionAtCall
				? // eslint-disable-next-line typescript/no-unsafe-type-assertion -- hasValue gates that `value` holds a real T
					({ v: cache.value as T } satisfies Box<T>)
				: null,
		(isCurrentClaim) => {
			// The real work, anchored independently so a cancelled owner's
			// fetch still settles and publishes. Publication is gated on the
			// claim so a reclaimed slow owner can't clobber the reclaimer's
			// value (same contract as initWithLock's own callers).
			const real = (async (): Promise<Box<T>> => {
				const value = await fetch();
				if (isCurrentClaim()) {
					cache.value = value;
					cache.hasValue = true;
					cache.valueVersion = versionAtCall;
				}
				return { v: value };
			})();
			// Anchor the real fetch (not the timeout race): this is what must
			// survive a cancelled owner and run to publication. initWithLock is
			// left to manage only the lock; we don't double-anchor.
			options.anchor?.(
				real.then(
					() => undefined,
					() => undefined,
				),
			);
			return ownerTimeoutMs === undefined ? real : withTimeout(real, ownerTimeoutMs);
		},
		{
			deadlineMs,
			pollMs: options.pollMs,
			maxWaitMs: options.maxWaitMs,
		},
	).then((box) => box.v);
}

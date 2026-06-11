/**
 * Reclaimable initialization lock for isolate-lifetime singletons.
 *
 * Guards "first request initializes, everyone else waits" sections
 * (runtime creation, database init) against a workerd failure mode: if the
 * request that owns the initialization is cancelled mid-await (client
 * disconnect, context teardown), its continuation — including any `finally`
 * that would release the lock — never runs. A plain boolean or shared
 * promise then stays stuck forever and every subsequent request in the
 * isolate hangs until the platform kills it (observed as 524s at the
 * 100-second wall limit, with the isolate poisoned until eviction).
 *
 * This lock instead records *when* the owner started. Waiters poll — we
 * deliberately never await a promise created by another request, which
 * workerd flags — and if the owner has held the lock past `deadlineMs`,
 * the next waiter assumes the owner is dead, reclaims the lock, and runs
 * the initialization itself. Waiters also give up after `maxWaitMs` so a
 * request degrades to an error response rather than hanging.
 */

export interface InitLock {
	/** Epoch ms when the current owner claimed the lock, or null when free. */
	ownerStartedAt: number | null;
}

export function createInitLock(): InitLock {
	return { ownerStartedAt: null };
}

export interface InitLockOptions {
	/**
	 * Reclaim the lock if the owner has held it longer than this. Must be
	 * comfortably above the slowest legitimate init (cold migrations on a
	 * contended D1, including the concurrent-migrator wait) — a too-short
	 * deadline risks two concurrent inits, a too-long one delays recovery
	 * of a poisoned isolate. Nested locks must compose: an outer lock's
	 * deadline must exceed the deadline of any lock its init acquires.
	 */
	deadlineMs?: number;
	/** Waiter poll interval. */
	pollMs?: number;
	/**
	 * Give up waiting after this long and throw instead of hanging.
	 * Defaults to `deadlineMs` plus headroom so a waiter always survives
	 * long enough to reclaim a dead owner before giving up.
	 */
	maxWaitMs?: number;
	/**
	 * Called with the in-flight init promise (errors pre-swallowed) so the
	 * caller can hand it to the host's lifetime extender (waitUntil via
	 * `after()`). If the owning request is cancelled mid-init, the anchored
	 * promise keeps the context alive: init completes, populates the cache,
	 * and the `finally` below releases the lock — preventing the poisoning
	 * instead of merely recovering from it via reclaim.
	 */
	anchor?: (promise: Promise<void>) => void;
}

const DEFAULT_DEADLINE_MS = 15_000;
const DEFAULT_POLL_MS = 50;
const MAX_WAIT_HEADROOM_MS = 15_000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Return the cached value if present, otherwise initialize it under the
 * lock. `init` is responsible for storing the value so that `getCached`
 * returns it on subsequent calls — waiters re-check `getCached` after the
 * owner finishes rather than sharing the owner's promise.
 */
export async function initWithLock<T>(
	lock: InitLock,
	getCached: () => T | null | undefined,
	init: () => Promise<T>,
	options?: InitLockOptions,
): Promise<T> {
	const deadlineMs = options?.deadlineMs ?? DEFAULT_DEADLINE_MS;
	const pollMs = options?.pollMs ?? DEFAULT_POLL_MS;
	const maxWaitMs = options?.maxWaitMs ?? deadlineMs + MAX_WAIT_HEADROOM_MS;
	// Date.now() is deliberate and only works because every loop iteration
	// awaits: in workerd the clock only advances across I/O, so a sync spin
	// would never observe the deadline. Don't "optimize" away the sleep.
	const waitStart = Date.now();

	for (;;) {
		const cached = getCached();
		if (cached !== null && cached !== undefined) {
			return cached;
		}

		const ownerStartedAt = lock.ownerStartedAt;
		if (ownerStartedAt === null || Date.now() - ownerStartedAt > deadlineMs) {
			// Free, or the owner has been gone past the deadline — claim it.
			// Synchronous between awaits, so two waiters can't both claim.
			lock.ownerStartedAt = Date.now();
			try {
				const initPromise = init();
				options?.anchor?.(
					initPromise.then(
						() => undefined,
						() => undefined,
					),
				);
				return await initPromise;
			} finally {
				// If this request dies mid-init unanchored this never runs;
				// the next waiter reclaims after deadlineMs instead.
				lock.ownerStartedAt = null;
			}
		}

		if (Date.now() - waitStart > maxWaitMs) {
			throw new Error(`initWithLock: timed out after ${maxWaitMs}ms waiting for initialization`);
		}
		await sleep(pollMs);
	}
}

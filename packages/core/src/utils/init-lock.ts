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
	 * contended D1) — a too-short deadline risks two concurrent inits, a
	 * too-long one delays recovery of a poisoned isolate.
	 */
	deadlineMs?: number;
	/** Waiter poll interval. */
	pollMs?: number;
	/** Give up waiting after this long and throw instead of hanging. */
	maxWaitMs?: number;
}

const DEFAULT_DEADLINE_MS = 15_000;
const DEFAULT_POLL_MS = 50;
const DEFAULT_MAX_WAIT_MS = 30_000;

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
	const maxWaitMs = options?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
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
				return await init();
			} finally {
				// If this request dies mid-init this never runs; the next
				// waiter reclaims after deadlineMs instead.
				lock.ownerStartedAt = null;
			}
		}

		if (Date.now() - waitStart > maxWaitMs) {
			throw new Error(`initWithLock: timed out after ${maxWaitMs}ms waiting for initialization`);
		}
		await sleep(pollMs);
	}
}

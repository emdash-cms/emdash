const CONTENT_USAGE_LOCKS_KEY = Symbol.for("emdash.mediaUsage.contentLocks.v2");
const CONTENT_USAGE_COLLECTION_LOCKS_KEY = Symbol.for("emdash.mediaUsage.collectionLocks.v2");
const CONTENT_USAGE_LOCK_POLL_MS = 5;
// Collection source deletion can take tens of seconds on D1.
const CONTENT_USAGE_LOCK_DEADLINE_MS = 60_000;
const CONTENT_USAGE_LOCK_MAX_WAIT_MS = 75_000;

type ContentUsageClaim = { startedAt: number };

export function withContentUsageLock<T>(
	collectionSlug: string,
	contentId: string,
	fn: () => Promise<T>,
): Promise<T> {
	return withPolledContentUsageLock(
		getLocks(CONTENT_USAGE_LOCKS_KEY),
		`${collectionSlug}\0${contentId}`,
		fn,
	);
}

export function withContentUsageCollectionLock<T>(
	collectionSlug: string,
	fn: () => Promise<T>,
): Promise<T> {
	// Serialize row refreshes with collection source deletes while the claim is live.
	return withPolledContentUsageLock(
		getLocks(CONTENT_USAGE_COLLECTION_LOCKS_KEY),
		collectionSlug,
		fn,
	);
}

// Best-effort coordination within this isolate: a cancelled request may never
// release its claim. Reclaim can overlap a slow owner, just as separate isolates
// can overlap; repository generation guards and durable work leases remain necessary.
async function withPolledContentUsageLock<T>(
	locks: Map<string, ContentUsageClaim>,
	key: string,
	fn: () => Promise<T>,
): Promise<T> {
	const waitStartedAt = Date.now();
	for (;;) {
		const held = locks.get(key);
		if (!held || Date.now() - held.startedAt > CONTENT_USAGE_LOCK_DEADLINE_MS) break;
		if (Date.now() - waitStartedAt > CONTENT_USAGE_LOCK_MAX_WAIT_MS) {
			throw new Error("Timed out waiting for media usage lock");
		}
		// Await only this request's timer, never another request's promise:
		// workerd can cancel a waiter that resumes in the owner's I/O context.
		await new Promise<void>((resolve) => setTimeout(resolve, CONTENT_USAGE_LOCK_POLL_MS));
	}
	const claim = { startedAt: Date.now() };
	locks.set(key, claim);
	try {
		return await fn();
	} finally {
		// A slow owner may finish after another request reclaimed its claim.
		if (locks.get(key) === claim) locks.delete(key);
	}
}

function getLocks(symbol: symbol): Map<string, ContentUsageClaim> {
	const global = globalThis as typeof globalThis & Record<symbol, unknown>;
	const existing = global[symbol];
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis symbol slot stores only this map
	if (existing instanceof Map) return existing as Map<string, ContentUsageClaim>;
	const locks = new Map<string, ContentUsageClaim>();
	global[symbol] = locks;
	return locks;
}

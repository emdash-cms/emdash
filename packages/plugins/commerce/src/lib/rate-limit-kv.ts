/**
 * Fixed-window rate limiting using plugin KV (survives across requests in production).
 *
 * **Best-effort only.** `consumeKvRateLimit` is a read-modify-write cycle with no
 * atomic guarantee. Under concurrent requests the counter can undercount, meaning
 * the actual rate allowed may exceed the configured limit. This is acceptable for
 * abuse throttling and cost control, but must not be relied on as a hard security
 * boundary or billing gate.
 */

import type { KVAccess } from "emdash";

import { nextRateLimitState, type RateBucket } from "../kernel/rate-limit-window.js";

const BUCKET_KEY = "state:ratelimit:";

function parseBucket(raw: unknown): RateBucket | null {
	if (raw === null || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	const count = o.count;
	const windowStartMs = o.windowStartMs;
	if (typeof count !== "number" || typeof windowStartMs !== "number") return null;
	return { count, windowStartMs };
}

/**
 * @returns `true` if the request is allowed; `false` if rate limited.
 */
export async function consumeKvRateLimit(input: {
	kv: KVAccess;
	keySuffix: string;
	limit: number;
	windowMs: number;
	nowMs: number;
}): Promise<boolean> {
	const key = `${BUCKET_KEY}${input.keySuffix}`;
	const prev = parseBucket(await input.kv.get<unknown>(key));
	const { allowed, bucket } = nextRateLimitState(prev, input.nowMs, input.limit, input.windowMs);
	await input.kv.set(key, bucket);
	return allowed;
}

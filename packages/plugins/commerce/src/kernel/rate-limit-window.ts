export type RateBucket = { count: number; windowStartMs: number };

/**
 * Fixed-window counter (simple, KV-friendly). Call after read-modify-write on KV.
 */
export function nextRateLimitState(
	prev: RateBucket | null,
	nowMs: number,
	limit: number,
	windowMs: number,
): { allowed: boolean; bucket: RateBucket } {
	if (limit < 1) {
		return { allowed: true, bucket: { count: 0, windowStartMs: nowMs } };
	}

	if (!prev || nowMs - prev.windowStartMs >= windowMs) {
		return {
			allowed: true,
			bucket: { count: 1, windowStartMs: nowMs },
		};
	}

	if (prev.count >= limit) {
		return { allowed: false, bucket: prev };
	}

	return {
		allowed: true,
		bucket: { count: prev.count + 1, windowStartMs: prev.windowStartMs },
	};
}

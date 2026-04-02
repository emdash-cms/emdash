export type RateBucket = { count: number; windowStartMs: number };

/**
 * Fixed-window counter (simple, KV-friendly). Call after read-modify-write on KV.
 *
 * Fail-safe behavior: invalid inputs are treated as a hard rate limit block instead
 * of silently disabling the limiter.
 */
export function nextRateLimitState(
	prev: RateBucket | null,
	nowMs: number,
	limit: number,
	windowMs: number,
): { allowed: boolean; bucket: RateBucket } {
	const previousWindow =
		prev === null || !Number.isFinite(prev.count) || !Number.isFinite(prev.windowStartMs)
			? null
			: prev;
	const safeWindowStartMs = previousWindow?.windowStartMs ?? nowMs;
	const safeNowMs = Number.isFinite(nowMs) ? nowMs : Number.NaN;

	if (
		!Number.isFinite(safeNowMs) ||
		safeNowMs < 0 ||
		!Number.isFinite(limit) ||
		!Number.isInteger(limit) ||
		limit < 1 ||
		!Number.isFinite(windowMs) ||
		!Number.isInteger(windowMs) ||
		windowMs < 1
	) {
		return {
			allowed: false,
			bucket: {
				count: previousWindow ? previousWindow.count : 0,
				windowStartMs: safeWindowStartMs,
			},
		};
	}

	const previousCount = Math.max(0, Math.trunc(previousWindow ? previousWindow.count : 0));

	if (!previousWindow || safeNowMs - previousWindow.windowStartMs >= windowMs) {
		return {
			allowed: true,
			bucket: { count: 1, windowStartMs: safeNowMs },
		};
	}

	if (previousCount >= limit) {
		return {
			allowed: false,
			bucket: {
				count: previousCount,
				windowStartMs: previousWindow.windowStartMs,
			},
		};
	}

	return {
		allowed: true,
		bucket: { count: previousCount + 1, windowStartMs: previousWindow.windowStartMs },
	};
}

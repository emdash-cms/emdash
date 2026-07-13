import { describe, expect, it } from "vitest";

import { isReviewAttemptStale, REVIEW_STALE_AFTER_MS } from "../.flue/lib/review-watchdog.js";

describe("review watchdog", () => {
	it("does not mark an attempt stale before its deadline", () => {
		expect(isReviewAttemptStale(1_000, 1_000 + REVIEW_STALE_AFTER_MS - 1)).toBe(false);
	});

	it("marks an attempt stale at its deadline", () => {
		expect(isReviewAttemptStale(1_000, 1_000 + REVIEW_STALE_AFTER_MS)).toBe(true);
	});
});

import { describe, expect, it } from "vitest";

import {
	isReviewAttemptStale,
	reviewStaleAfter,
	REVIEW_STALE_AFTER_MS,
} from "../.flue/lib/review-watchdog.js";

describe("review watchdog", () => {
	it("allows model review 15 minutes", () => {
		expect(REVIEW_STALE_AFTER_MS).toBe(15 * 60_000);
	});

	it("does not mark an attempt stale before its deadline", () => {
		expect(isReviewAttemptStale(1_000, 1_000 + REVIEW_STALE_AFTER_MS - 1)).toBe(false);
	});

	it("marks an attempt stale at its deadline", () => {
		expect(isReviewAttemptStale(1_000, 1_000 + REVIEW_STALE_AFTER_MS)).toBe(true);
	});

	it("uses a shorter deadline while hydrating", () => {
		const deadline = reviewStaleAfter("hydrating");
		expect(deadline).toBe(3 * 60_000);
		expect(isReviewAttemptStale(1_000, 1_000 + deadline, "hydrating")).toBe(true);
	});
});

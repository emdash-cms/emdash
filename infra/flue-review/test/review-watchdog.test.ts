import { describe, expect, it, vi } from "vitest";

import {
	MERGE_ATTEMPTS,
	MERGE_TIMEOUT_MS,
	MODEL_REVIEW_STAGE_LIMIT_MS,
	REVIEW_PHASE_LIMIT_MS,
	reviewerTimeoutMs,
} from "../.flue/lib/review-panel.js";
import {
	isReviewAttemptStale,
	reviewStaleAfter,
	REVIEW_STALE_AFTER_MS,
	STAGE_HEARTBEAT_INTERVAL_MS,
	withStageHeartbeats,
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

	it("allows a review publisher to wait through GitHub's hourly rate-limit window", () => {
		expect(reviewStaleAfter("posting_review")).toBeGreaterThan(60 * 60_000);
	});
});

describe("withStageHeartbeats", () => {
	it("heartbeats inside the stale deadline until the stage settles", async () => {
		vi.useFakeTimers();
		try {
			let beats = 0;
			let finish: (value: string) => void = () => {};
			const stage = withStageHeartbeats(
				() =>
					new Promise<string>((resolve) => {
						finish = resolve;
					}),
				{
					beat: async () => {
						beats++;
						return true;
					},
					maxMs: 60 * 60_000,
				},
			);
			expect(STAGE_HEARTBEAT_INTERVAL_MS).toBeLessThan(reviewStaleAfter("model_review"));
			await vi.advanceTimersByTimeAsync(STAGE_HEARTBEAT_INTERVAL_MS * 4);
			expect(beats).toBe(4);
			finish("done");
			await expect(stage).resolves.toBe("done");
			await vi.advanceTimersByTimeAsync(STAGE_HEARTBEAT_INTERVAL_MS * 2);
			expect(beats).toBe(4);
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops heartbeating after the stage limit so a hung stage goes stale", async () => {
		vi.useFakeTimers();
		try {
			let beats = 0;
			void withStageHeartbeats(() => new Promise<never>(() => {}), {
				beat: async () => {
					beats++;
					return true;
				},
				maxMs: STAGE_HEARTBEAT_INTERVAL_MS * 3,
			});
			await vi.advanceTimersByTimeAsync(STAGE_HEARTBEAT_INTERVAL_MS * 10);
			expect(beats).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("aborts the stage when the attempt is no longer active", async () => {
		vi.useFakeTimers();
		try {
			const stage = withStageHeartbeats(
				(signal) =>
					new Promise<never>((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason));
					}),
				{ beat: async () => false, maxMs: 60 * 60_000 },
			);
			const settled = expect(stage).rejects.toThrow("no longer active");
			await vi.advanceTimersByTimeAsync(STAGE_HEARTBEAT_INTERVAL_MS);
			await settled;
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("model review stage limits", () => {
	it("keeps the slowest reviewer plus the merge inside the stage limit", () => {
		const slowestReviewer = Math.max(
			reviewerTimeoutMs("cloudflare/@cf/moonshotai/kimi-k2.7-code"),
			reviewerTimeoutMs("anthropic/claude-opus-5-5"),
		);
		expect(slowestReviewer).toBeLessThanOrEqual(REVIEW_PHASE_LIMIT_MS);
		expect(REVIEW_PHASE_LIMIT_MS + MERGE_ATTEMPTS * MERGE_TIMEOUT_MS).toBeLessThan(
			MODEL_REVIEW_STAGE_LIMIT_MS,
		);
	});
});

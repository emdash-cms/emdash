import { describe, expect, it } from "vitest";

import { formatReviewFailureSummary } from "../.flue/lib/review-failure.js";

describe("formatReviewFailureSummary", () => {
	it("exposes the actionable provider error in the failed check", () => {
		const error = new Error(
			'skill("review") failed: Cloudflare AI binding request failed with 413 Payload Too Large.',
		);
		error.name = "FlueError";

		expect(formatReviewFailureSummary("model_review", error)).toContain(
			"Cloudflare AI binding request failed with 413 Payload Too Large.",
		);
	});

	it("bounds error detail before publishing it on GitHub", () => {
		const summary = formatReviewFailureSummary("model_review", new Error("x".repeat(10_000)));

		expect(summary.length).toBeLessThanOrEqual(700);
		expect(summary).toContain("Reapply the `bot:review` label to retry.");
	});
});

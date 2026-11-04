import { describe, expect, it } from "vitest";

import { isProvenFirstRelease } from "../src/listing-policy.js";

describe("isProvenFirstRelease", () => {
	it("requires one release and explicitly complete history", () => {
		expect(
			isProvenFirstRelease({
				historicalReleaseCount: 1,
				releaseHistoryComplete: true,
			}),
		).toBe(true);
	});

	it.each([
		{},
		{ historicalReleaseCount: 1 },
		{ historicalReleaseCount: 1, releaseHistoryComplete: false },
		{ historicalReleaseCount: 0, releaseHistoryComplete: true },
		{ historicalReleaseCount: 2, releaseHistoryComplete: true },
		{ historicalReleaseCount: 1.5, releaseHistoryComplete: true },
	])("fails closed for incomplete or malformed evidence %#", (evidence) => {
		expect(isProvenFirstRelease(evidence)).toBe(false);
	});
});

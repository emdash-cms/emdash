import { describe, expect, it } from "vitest";

import { reactionScore, wilsonLowerBound } from "../../../src/comments/ranking.js";

describe("wilsonLowerBound", () => {
	it("returns 0 when there are no reactions", () => {
		expect(wilsonLowerBound(0, 0)).toBe(0);
	});

	it("increases monotonically with positive count (positive-only)", () => {
		const a = wilsonLowerBound(1, 0);
		const b = wilsonLowerBound(10, 0);
		const c = wilsonLowerBound(200, 0);
		expect(a).toBeGreaterThan(0);
		expect(a).toBeLessThan(b);
		expect(b).toBeLessThan(c);
		expect(c).toBeLessThan(1);
	});

	it("penalizes low-sample comments vs high-sample at the same ratio", () => {
		// 100% positive but a tiny sample must rank below a large confident sample.
		expect(wilsonLowerBound(1, 0)).toBeLessThan(wilsonLowerBound(100, 0));
		expect(wilsonLowerBound(2, 0)).toBeLessThan(wilsonLowerBound(20, 0));
	});

	it("ranks a high positive ratio above a mixed one at similar volume", () => {
		expect(wilsonLowerBound(90, 10)).toBeGreaterThan(wilsonLowerBound(50, 50));
	});

	it("matches the known Wilson value for 10/0 at z=1.96", () => {
		expect(wilsonLowerBound(10, 0)).toBeCloseTo(0.7224, 3);
	});
});

describe("reactionScore", () => {
	it("treats unknown reactions as positive", () => {
		expect(reactionScore({ like: 10 })).toBeCloseTo(wilsonLowerBound(10, 0), 10);
		expect(reactionScore({ love: 5, like: 5 })).toBeCloseTo(wilsonLowerBound(10, 0), 10);
	});

	it("treats dislike/down as negative", () => {
		expect(reactionScore({ like: 90, dislike: 10 })).toBeCloseTo(wilsonLowerBound(90, 10), 10);
		expect(reactionScore({ up: 50, down: 50 })).toBeCloseTo(wilsonLowerBound(50, 50), 10);
	});

	it("returns 0 for empty counts", () => {
		expect(reactionScore({})).toBe(0);
	});
});

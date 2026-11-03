import { describe, expect, it } from "vitest";

import {
	buildMergePrompt,
	fallbackMerge,
	mergeReviews,
	withReviewFooter,
	type ReviewerResult,
} from "../.flue/lib/review-merge.js";
import type { ReviewResult } from "../.flue/lib/review-schema.js";

type Finding = ReviewResult["findings"][number];

function finding(
	path: string,
	line: number,
	body: string,
	severity: Finding["severity"] = "needs_fixing",
): Finding {
	return { path, line, side: "RIGHT", severity, body };
}

const cacheGate = finding("src/settings.ts", 275, "Bypass never runs without an object cache.");
const cacheGateAgain = finding(
	"src/settings.ts",
	276,
	"Route-cache fills skip the bypass with no object cache.",
);
const testGap = finding(
	"tests/settings.test.ts",
	608,
	"The test sets the flag by hand.",
	"suggestion",
);
const changeset = finding(".changeset/a.md", 5, "The changeset overstates the fix.");

const opus: ReviewerResult = {
	reviewer: "opus",
	result: { verdict: "comment", summary: "Opus summary.", findings: [cacheGate, testGap] },
};
const sol: ReviewerResult = {
	reviewer: "sol",
	result: { verdict: "approve", summary: "Sol summary.", findings: [cacheGateAgain, changeset] },
};

describe("mergeReviews", () => {
	it("merges two reviews and computes the verdict in code", async () => {
		const outcome = await mergeReviews([opus, sol], async () => ({
			verdict: "approve",
			summary: "Approach is sound; the bypass misses the reporter's setup.",
			findings: [cacheGate, testGap, changeset],
		}));
		expect(outcome.source).toBe("merged");
		expect(outcome.result.verdict).toBe("comment");
		expect(outcome.result.findings).toHaveLength(3);
		// Sol's duplicate of the cache-gate finding was collapsed into Opus's anchor.
		expect(outcome.uncoveredInputs).toEqual([{ reviewer: "sol", finding: cacheGateAgain }]);
	});

	it("requests changes when either reviewer did", async () => {
		const blocking = { ...sol, result: { ...sol.result, verdict: "request_changes" as const } };
		const outcome = await mergeReviews([opus, blocking], async () => ({
			verdict: "comment",
			summary: "Merged.",
			findings: [cacheGate, testGap, changeset],
		}));
		expect(outcome.result.verdict).toBe("request_changes");
	});

	it("approves only when both approved and nothing needs fixing", async () => {
		const clean = (reviewer: string): ReviewerResult => ({
			reviewer,
			result: { verdict: "approve", summary: "Fine.", findings: [] },
		});
		const outcome = await mergeReviews([clean("a"), clean("b")], async () => ({
			verdict: "approve",
			summary: "Both found nothing to fix.",
			findings: [],
		}));
		expect(outcome.result.verdict).toBe("approve");
	});

	it("returns a single review unchanged apart from a note", async () => {
		const outcome = await mergeReviews([opus], async () => {
			throw new Error("not called");
		});
		expect(outcome.source).toBe("single");
		expect(outcome.result.findings).toEqual(opus.result.findings);
		expect(outcome.result.verdict).toBe(opus.result.verdict);
		expect(outcome.result.summary).toContain("Opus summary.");
		expect(outcome.result.summary).toContain("other reviewer was unavailable");
	});

	it("falls back to the deterministic union when the merge model throws", async () => {
		const outcome = await mergeReviews([opus, sol], async () => {
			throw new Error("gateway timeout");
		});
		expect(outcome.source).toBe("fallback");
		expect(outcome.error).toContain("gateway timeout");
		expect(outcome.result).toEqual(fallbackMerge([opus, sol]));
	});

	it("falls back when the merge output does not match the schema", async () => {
		const outcome = await mergeReviews([opus, sol], async () => ({
			verdict: "lgtm",
			findings: [],
		}));
		expect(outcome.source).toBe("fallback");
		expect(outcome.error).toContain("validation");
	});

	it("repairs an anchor moved within a reviewed file and drops one in another file", async () => {
		const outcome = await mergeReviews([opus, sol], async () => ({
			verdict: "comment",
			summary: "Merged.",
			findings: [
				{ ...cacheGate, line: 290 },
				testGap,
				changeset,
				finding("src/elsewhere.ts", 10, "Invented."),
			],
		}));
		expect(outcome.repairedAnchors).toBe(1);
		expect(outcome.droppedAnchors).toBe(1);
		expect(outcome.result.findings.map((f) => `${f.path}:${f.line}`)).toEqual([
			"src/settings.ts:276",
			"tests/settings.test.ts:608",
			".changeset/a.md:5",
		]);
	});

	it("reports an input finding the merge dropped", async () => {
		const outcome = await mergeReviews([opus, sol], async () => ({
			verdict: "comment",
			summary: "Merged.",
			findings: [cacheGate, cacheGateAgain, changeset],
		}));
		expect(outcome.uncoveredInputs).toEqual([{ reviewer: "opus", finding: testGap }]);
	});
});

describe("re-review merges", () => {
	const priorReview = [
		"Your previous review (state: COMMENTED):",
		"",
		"### Your inline findings, newest first, with the replies to each",
		"",
		"- tests/settings.test.ts:608 The test sets the flag by hand.",
		"  - author: Fixed in the latest push; the test now drives a real fill.",
	].join("\n");

	it("gives the merge the prior-review context and the no-resurrection rule", () => {
		const prompt = buildMergePrompt([opus, sol], { priorReview });
		expect(prompt).toContain("This is a re-review. Do not resurrect a finding");
		expect(prompt).toContain("Fixed in the latest push");
		expect(buildMergePrompt([opus, sol])).not.toContain("re-review");
	});

	it("accepts a merge that drops a finding the author already resolved", async () => {
		let prompt = "";
		const outcome = await mergeReviews(
			[opus, sol],
			async (text) => {
				prompt = text;
				return {
					verdict: "comment",
					summary: "The cache gate is still open; the test gap was fixed.",
					findings: [cacheGate, changeset],
				};
			},
			{ priorReview },
		);
		expect(prompt).toContain("## Prior review context");
		expect(outcome.source).toBe("merged");
		expect(outcome.result.findings).toEqual([cacheGate, changeset]);
		expect(outcome.uncoveredInputs).toContainEqual({ reviewer: "opus", finding: testGap });
	});
});

describe("withReviewFooter", () => {
	it("appends the footer and keeps the summary within the limit", () => {
		const result = withReviewFooter(
			{ verdict: "comment", summary: "x".repeat(8_000), findings: [] },
			"Reviewed by a and b.",
		);
		expect(result.summary.length).toBeLessThanOrEqual(8_000);
		expect(result.summary.endsWith("\n\n---\nReviewed by a and b.")).toBe(true);
	});
});

describe("fallbackMerge", () => {
	it("dedupes only same-path overlapping anchors and keeps both summaries", () => {
		const overlapping = { ...cacheGate, line: 280, startLine: 274 };
		const result = fallbackMerge([
			opus,
			{
				reviewer: "sol",
				result: { ...sol.result, findings: [overlapping, cacheGateAgain, changeset] },
			},
		]);
		expect(result.findings).toEqual([cacheGate, testGap, cacheGateAgain, changeset]);
		expect(result.summary).toContain("### opus\n\nOpus summary.");
		expect(result.summary).toContain("### sol\n\nSol summary.");
		expect(result.verdict).toBe("comment");
	});
});

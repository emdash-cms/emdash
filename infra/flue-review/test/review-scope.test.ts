import { describe, expect, it } from "vitest";

import type { ReviewResult } from "../.flue/lib/review-schema.js";
import {
	changedLineCount,
	changedLines,
	DEFAULT_FOLLOW_UP_MAX_LINES,
	DEFAULT_MAX_SUGGESTIONS,
	followUpMaxLines,
	followUpScope,
	maxSuggestions,
	MISSED_EARLIER_PREFIX,
	scopeReview,
} from "../.flue/lib/review-scope.js";

type Finding = ReviewResult["findings"][number];

const DIFF = [
	"diff --git a/src/cache.ts b/src/cache.ts",
	"index 1111111..2222222 100644",
	"--- a/src/cache.ts",
	"+++ b/src/cache.ts",
	"@@ -10,4 +10,5 @@ export function read() {",
	" const a = 1;",
	"-const b = 2;",
	"+const b = 3;",
	"+const c = 4;",
	" return a;",
	"@@ -40,3 +41,2 @@",
	" one();",
	"-two();",
	" three();",
	"diff --git a/src/new.ts b/src/new.ts",
	"new file mode 100644",
	"--- /dev/null",
	"+++ b/src/new.ts",
	"@@ -0,0 +1,2 @@",
	"+export const x = 1;",
	"+export const y = 2;",
].join("\n");

const finding = (
	path: string,
	line: number,
	severity: Finding["severity"],
	extra: Partial<Finding> = {},
): Finding => ({ path, line, side: "RIGHT", severity, body: `At ${path}:${line}.`, ...extra });

describe("changedLines", () => {
	it("numbers added lines and deletion points in the new file", () => {
		const changed = changedLines(DIFF);
		expect([...(changed.get("src/cache.ts") ?? [])]).toEqual([11, 12, 42]);
		expect([...(changed.get("src/new.ts") ?? [])]).toEqual([1, 2]);
	});
});

describe("scopeReview", () => {
	const changed = changedLines(DIFF);

	it("drops a suggestion outside the change and marks a needs_fixing one as missed earlier", () => {
		const outcome = scopeReview(
			{
				verdict: "comment",
				summary: "Follow-up.",
				findings: [
					finding("src/cache.ts", 11, "suggestion"),
					finding("src/cache.ts", 30, "suggestion"),
					finding("src/other.ts", 5, "suggestion"),
					finding("src/cache.ts", 30, "needs_fixing"),
					finding("src/cache.ts", 12, "needs_fixing", { startLine: 9 }),
				],
			},
			{ changed, maxSuggestions: 3 },
		);
		expect(outcome.droppedOutsideChange).toBe(2);
		expect(outcome.markedMissedEarlier).toBe(1);
		expect(outcome.result.findings.map((f) => `${f.severity}@${f.line}`)).toEqual([
			"suggestion@11",
			"needs_fixing@30",
			"needs_fixing@12",
		]);
		expect(outcome.result.findings[1]?.body.startsWith(MISSED_EARLIER_PREFIX)).toBe(true);
		expect(outcome.result.findings[2]?.body.startsWith(MISSED_EARLIER_PREFIX)).toBe(false);
		expect(outcome.result.verdict).toBe("comment");
	});

	it("approves a follow-up with no needs_fixing left, whatever suggestions remain", () => {
		const outcome = scopeReview(
			{
				verdict: "comment",
				summary: "Addressed.",
				findings: [finding("src/new.ts", 2, "suggestion")],
			},
			{ changed, maxSuggestions: 3 },
		);
		expect(outcome.result.verdict).toBe("approve");
		expect(outcome.result.findings).toHaveLength(1);
	});

	it("keeps every needs_fixing and the first suggestions up to the limit in every review", () => {
		const findings = [
			finding("a.ts", 1, "suggestion"),
			finding("a.ts", 2, "needs_fixing"),
			finding("a.ts", 3, "suggestion"),
			finding("a.ts", 4, "suggestion"),
			finding("a.ts", 5, "suggestion"),
			finding("a.ts", 6, "needs_fixing"),
		];
		const outcome = scopeReview(
			{ verdict: "comment", summary: "Full.", findings },
			{ maxSuggestions: DEFAULT_MAX_SUGGESTIONS },
		);
		expect(outcome.droppedOverLimit).toBe(1);
		expect(outcome.result.findings.map((f) => f.line)).toEqual([1, 2, 3, 4, 6]);
		expect(outcome.result.verdict).toBe("comment");
	});

	it("treats a LEFT-side anchor in a changed file as in scope", () => {
		const outcome = scopeReview(
			{
				verdict: "comment",
				summary: "x",
				findings: [finding("src/cache.ts", 3, "suggestion", { side: "LEFT" })],
			},
			{ changed, maxSuggestions: 3 },
		);
		expect(outcome.result.findings).toHaveLength(1);
	});

	it("reads the suggestion limit from configuration", () => {
		expect(maxSuggestions({})).toBe(3);
		expect(maxSuggestions({ REVIEW_MAX_SUGGESTIONS: "0" })).toBe(0);
	});
});

describe("followUpScope", () => {
	const prDiff = [
		"diff --git a/src/a.ts b/src/a.ts",
		"--- a/src/a.ts",
		"+++ b/src/a.ts",
		"@@ -1,1 +1,1 @@",
		"-old",
		"+new",
	].join("\n");
	function followUpDiff(changes: number): string {
		const hunk = Array.from({ length: changes }, (_, i) => `+line ${i}`);
		return [
			"diff --git a/src/a.ts b/src/a.ts",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			`@@ -1,0 +1,${changes} @@`,
			...hunk,
			"diff --git a/src/elsewhere.ts b/src/elsewhere.ts",
			"--- a/src/elsewhere.ts",
			"+++ b/src/elsewhere.ts",
			"@@ -1,2000 +0,0 @@",
			...Array.from({ length: 2000 }, (_, i) => `-gone ${i}`),
		].join("\n");
	}

	it("counts added and deleted lines only in the PR's files", () => {
		expect(changedLineCount(followUpDiff(12), new Set(["src/a.ts"]))).toBe(12);
	});

	it("stays scoped just under the threshold and becomes a full review just over it", () => {
		const under = followUpScope(
			prDiff,
			followUpDiff(DEFAULT_FOLLOW_UP_MAX_LINES),
			DEFAULT_FOLLOW_UP_MAX_LINES,
		);
		expect(under).toMatchObject({ scoped: true, lines: DEFAULT_FOLLOW_UP_MAX_LINES });
		const over = followUpScope(
			prDiff,
			followUpDiff(DEFAULT_FOLLOW_UP_MAX_LINES + 1),
			DEFAULT_FOLLOW_UP_MAX_LINES,
		);
		expect(over).toEqual({ scoped: false, lines: DEFAULT_FOLLOW_UP_MAX_LINES + 1 });
	});

	it("reads the threshold from configuration", () => {
		expect(followUpMaxLines({})).toBe(1_000);
		expect(followUpMaxLines({ REVIEW_FOLLOWUP_MAX_LINES: "250" })).toBe(250);
	});
});

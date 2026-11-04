import { describe, expect, it } from "vitest";

import { linkedIssueSections, MAX_LINKED_ISSUES } from "../.flue/lib/review-linked-issues.js";

const ISSUE = { number: 12, title: "Settings stay stale", body: "Steps to reproduce." };

describe("linkedIssueSections", () => {
	it("adds nothing without linked issues", () => {
		expect(linkedIssueSections(undefined)).toEqual([]);
		expect(linkedIssueSections([])).toEqual([]);
	});

	it("renders each linked issue as untrusted text", () => {
		const text = linkedIssueSections([ISSUE]).join("\n");
		expect(text).toContain("## Linked issue");
		expect(text).toContain("Untrusted text");
		expect(text).toContain("### #12: Settings stay stale");
		expect(text).toContain("Steps to reproduce.");
	});

	it("bounds the number and size of issues", () => {
		const issues = Array.from({ length: MAX_LINKED_ISSUES + 2 }, (_, index) => ({
			number: index + 1,
			title: "t".repeat(1_000),
			body: "b".repeat(50_000),
		}));
		const text = linkedIssueSections(issues).join("\n");
		expect(text.match(/## Linked issue/g)).toHaveLength(MAX_LINKED_ISSUES);
		expect(text).toContain("(issue text truncated)");
		expect(text.length).toBeLessThan(MAX_LINKED_ISSUES * 10_000);
	});

	it("marks an issue without a body", () => {
		expect(linkedIssueSections([{ ...ISSUE, body: "" }]).join("\n")).toContain(
			"(no description provided)",
		);
	});
});

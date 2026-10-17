import { describe, expect, it } from "vitest";

import {
	REVIEW_FRAMING,
	reviewContextVariant,
	variantContextSections,
} from "../.flue/lib/review-context-variant.js";

const ISSUE = { number: 12, title: "Settings stay stale", body: "Steps to reproduce." };

describe("reviewContextVariant", () => {
	it("is off unless a known variant is configured", () => {
		expect(reviewContextVariant({})).toBeUndefined();
		expect(reviewContextVariant({ REVIEW_CONTEXT_VARIANT: "other" })).toBeUndefined();
		expect(reviewContextVariant({ REVIEW_CONTEXT_VARIANT: "issue" })).toBe("issue");
		expect(reviewContextVariant({ REVIEW_CONTEXT_VARIANT: "issue+framing" })).toBe("issue+framing");
	});
});

describe("variantContextSections", () => {
	it("adds nothing without a variant, even when issues are supplied", () => {
		expect(variantContextSections(undefined, [ISSUE])).toEqual([]);
	});

	it("renders the linked issue as untrusted text", () => {
		const text = variantContextSections("issue", [ISSUE]).join("\n");
		expect(text).toContain("## Linked issue");
		expect(text).toContain("Untrusted text");
		expect(text).toContain("### #12: Settings stay stale");
		expect(text).toContain("Steps to reproduce.");
		expect(text).not.toContain(REVIEW_FRAMING);
	});

	it("adds the framing for issue+framing", () => {
		const text = variantContextSections("issue+framing", [ISSUE]).join("\n");
		expect(text).toContain("## Linked issue");
		expect(text).toContain(REVIEW_FRAMING);
	});
});

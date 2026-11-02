import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

describe("Comments & CommentForm dark mode styles", () => {
	test("Comments.astro includes dark mode variables and prefers-color-scheme queries", () => {
		const commentsFile = path.resolve(__dirname, "../../src/components/Comments.astro");
		const content = fs.readFileSync(commentsFile, "utf-8");

		expect(content).toContain("--ec-comment-border: 1px solid var(--ec-comment-border-color, #e5e7eb);");
		expect(content).toContain(":global(.dark) .ec-comments");
		expect(content).toContain("--ec-comment-border-color: #374151;");
		expect(content).toContain("@media (prefers-color-scheme: dark)");
	});

	test("CommentForm.astro includes dark mode styles for inputs, user info, and submit button", () => {
		const formFile = path.resolve(__dirname, "../../src/components/CommentForm.astro");
		const content = fs.readFileSync(formFile, "utf-8");

		// Dark mode for inputs
		expect(content).toContain(":global(.dark) .ec-comment-form-field input");
		expect(content).toContain("@media (prefers-color-scheme: dark)");

		// Dark mode for user info including border
		expect(content).toContain(":global(.dark) .ec-comment-user-info");
		expect(content).toContain("border-color: var(--ec-form-user-border-dark, #4b5563);");

		// Dark mode for submit button
		expect(content).toContain(":global(.dark) .ec-comment-form-submit");
		expect(content).toContain("--ec-form-submit-bg: #f3f4f6;");
		expect(content).toContain("--ec-form-submit-color: #111827;");
	});
});

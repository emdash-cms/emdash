// Shared types for the investigation-bot eval harness.
//
// The harness drives the DEPLOYED worker's investigate agent against a curated
// set of closed issues and scores each verdict against recorded ground truth.
// It cannot run in CI (it needs live bindings + a deployed worker); only the
// pure pieces here -- dataset loading, scoring, formatting -- are unit-tested.

export type Category = "CONFIRMED_BUG" | "NOT_REPRODUCIBLE" | "NEEDS_INFO";

/** Recorded fixing-PR merge data. `parents[0]` is the pre-fix commit to check out. */
export interface PreFix {
	/** The fixing PR's squash-merge commit on main. */
	readonly merge_commit: string;
	/** The merge commit's parent SHAs; the first is the pre-fix state. */
	readonly parents: readonly string[];
	/** Optional provenance note (e.g. a re-landed fix under a different PR number). */
	readonly note?: string;
}

export interface EvalCase {
	readonly number: number;
	readonly title: string;
	readonly category: Category;
	readonly ground_truth: string;
	readonly fixing_pr: number | null;
	readonly difficulty: "easy" | "medium" | "hard";
	readonly repro_path: string;
	readonly area: string;
	/** Present (non-null) only for CONFIRMED_BUG cases. */
	readonly pre_fix: PreFix | null;
	/** Fault-area identifiers a correct diagnosis should reference. Empty for negatives. */
	readonly fault_anchors: readonly string[];
}

export interface Dataset {
	readonly counts: Record<string, number>;
	readonly cases: readonly EvalCase[];
}

/**
 * The investigate agent's structured result, reported via `report_result`.
 * Mirrors the agent's `reportedResultSchema`.
 */
export interface ReportedResult {
	readonly result: AgentResult;
	readonly ok: boolean;
	readonly pushed: boolean;
	readonly runId: string;
	readonly publication: CandidatePublication | null;
	readonly verification: readonly VerificationRecord[];
}

export interface CandidatePublication {
	readonly branch: string;
	readonly commitSha: string;
	readonly files: readonly string[];
}

export interface VerificationRecord {
	readonly name: string;
	readonly command: string;
	readonly exitCode: number;
	readonly candidateTreeSha: string;
}

export interface AgentResult {
	readonly skipped?: boolean;
	readonly reproduced?: boolean;
	readonly rootCauseFound?: boolean;
	readonly fixed?: boolean;
	readonly implemented?: boolean;
	readonly verdict?: string;
	readonly summary?: string;
	readonly failureStage?: "workspace" | "verification" | "publication" | "reporting";
	readonly screenshots?: readonly unknown[];
}

/**
 * Diagnose-mode outcome. Mirrors the machine event `outcomeFromResult` derives
 * for `mode: "diagnose"` (agent.reproduced / diagnosed / not_reproduced /
 * needs_info / by_design / skipped / failed), minus the `agent.` prefix.
 */
export type DiagnoseOutcome =
	| "reproduced"
	| "diagnosed"
	| "not_reproduced"
	| "needs_info"
	| "by_design"
	| "skipped"
	| "failed";

/**
 * - `pass`   — the verdict matches ground truth.
 * - `miss`   — wrong verdict, but not a confident false positive (e.g. failed to
 *   reproduce a real bug, or dug in on a needs-info case instead of asking).
 * - `confident_wrong` — asserted a reproduction on a case that has nothing to
 *   reproduce (a not-reproducible or needs-info case). THE GATE: this must be 0.
 * - `error`  — the harness could not obtain a verdict (dispatch/timeout/no
 *   result). An infra failure to fix and re-run, not a bot verdict.
 */
export type Grade = "pass" | "diagnosed" | "miss" | "confident_wrong" | "error";

export interface ScoredResult {
	readonly number: number;
	readonly category: Category;
	readonly difficulty: EvalCase["difficulty"];
	readonly checkoutRef: string;
	readonly outcome: DiagnoseOutcome;
	readonly grade: Grade;
	readonly confidentWrong: boolean;
	/** Fault anchors found in the summary (CONFIRMED_BUG only). */
	readonly anchorsMatched: readonly string[];
	readonly summary: string | null;
	readonly reason: string;
	/** Set when grade is "error". */
	readonly error?: string;
}

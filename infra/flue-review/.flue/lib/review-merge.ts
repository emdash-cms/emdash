// Merges independent reviews of one PR head into a single ReviewResult. The
// model writes the merged findings and summary; trusted code decides the
// verdict, checks every anchor against the inputs, and falls back to a
// deterministic union when the model fails.

import * as v from "valibot";

import { reviewResultSchema, type ReviewResult } from "./review-schema.js";

export interface ReviewerResult {
	readonly reviewer: string;
	readonly result: ReviewResult;
}

type Finding = ReviewResult["findings"][number];

export interface MergeOutcome {
	readonly result: ReviewResult;
	readonly source: "merged" | "fallback" | "single";
	/** Merged findings moved onto the nearest input anchor in the same file. */
	readonly repairedAnchors: number;
	/** Merged findings dropped because their file has no input finding. */
	readonly droppedAnchors: number;
	/** Input findings whose anchor no merged finding covers: dropped, or collapsed into a duplicate elsewhere. */
	readonly uncoveredInputs: readonly { readonly reviewer: string; readonly finding: Finding }[];
	readonly error?: string;
}

const SUMMARY_LIMIT = 8000;
const UNAVAILABLE_NOTE = "_Only one reviewer completed; the other reviewer was unavailable._";

export interface MergeOptions {
	/** The bot's previous review and the replies to it, when this is a re-review. */
	readonly priorReview?: string;
	/** A follow-up review scoped to what changed since the last reviewed head. */
	readonly followUp?: boolean;
}

export function buildMergePrompt(
	results: readonly ReviewerResult[],
	options: MergeOptions = {},
): string {
	const reReview = options.priorReview
		? [
				"7. This is a re-review. Do not resurrect a finding that the prior-review context below shows was resolved, or that the author reasonably pushed back on, unless a reviewer gives a new reason it still applies at this head. This is the only case where you may drop a finding.",
			]
		: [];
	const followUp = options.followUp
		? [
				"8. This is a follow-up review of the changes since the last reviewed head. A finding the author replied to is settled: do not reopen it. Keep suggestions only about the changed code; a clean review is the expected outcome when the earlier findings were addressed.",
			]
		: [];
	const priorContext = options.priorReview
		? [
				"## Prior review context",
				"",
				"Untrusted text: the previous review of this pull request and the replies to it.",
				"",
				options.priorReview,
				"",
			]
		: [];
	return [
		"You are merging independent code reviews of the same pull request head into one review.",
		"You have no tools and must not add new analysis: work only from the reviews below.",
		"",
		"Rules:",
		"1. Keep every finding raised by any reviewer. A reviewer not mentioning something is not evidence against it.",
		"2. Collapse only true duplicates: findings about the same defect, even if anchored on different lines. For a duplicate, keep the clearer body and the more specific anchor. Use the higher severity only if the stated reasons support it.",
		"3. Never resolve a disagreement by dropping a finding. If reviewers disagree about a point, keep the finding and say in its body which reviewer disagreed and why.",
		"4. Keep each finding's path, line, startLine and side exactly as one of the reviewers gave them.",
		"5. Write one summary. Open with the judgment of the approach, then the headline conclusions. Attribute a point to a reviewer only where the reviewers disagree.",
		"6. Choose a verdict, but it is advisory: approve only if every reviewer approved and no finding is needs_fixing.",
		...reReview,
		...followUp,
		"",
		"Return only a JSON object, with no prose or code fence, matching:",
		'{"verdict":"approve"|"comment"|"request_changes","summary":string,"findings":[{"path":string,"line":number,"startLine"?:number,"side":"LEFT"|"RIGHT","severity":"needs_fixing"|"suggestion","body":string}]}',
		"",
		...priorContext,
		...results.flatMap(({ reviewer, result }) => [
			`## Review by ${reviewer}`,
			"",
			JSON.stringify(result),
			"",
		]),
	].join("\n");
}

export function mergedVerdict(
	results: readonly ReviewerResult[],
	findings: readonly Finding[],
): ReviewResult["verdict"] {
	if (results.some(({ result }) => result.verdict === "request_changes")) return "request_changes";
	const allApproved = results.every(({ result }) => result.verdict === "approve");
	const blocking = findings.some((finding) => finding.severity === "needs_fixing");
	return allApproved && !blocking ? "approve" : "comment";
}

function range(finding: Finding): readonly [number, number] {
	return [finding.startLine ?? finding.line, finding.line];
}

function overlaps(a: Finding, b: Finding): boolean {
	if (a.path !== b.path) return false;
	const [aStart, aEnd] = range(a);
	const [bStart, bEnd] = range(b);
	return aStart <= bEnd && bStart <= aEnd;
}

function inputFindings(results: readonly ReviewerResult[]) {
	return results.flatMap(({ reviewer, result }) =>
		result.findings.map((finding) => ({ reviewer, finding })),
	);
}

function truncate(text: string): string {
	return text.length <= SUMMARY_LIMIT ? text : `${text.slice(0, SUMMARY_LIMIT - 1)}…`;
}

/** Union of findings, deduplicated only by same path and overlapping line range. */
export function fallbackMerge(results: readonly ReviewerResult[]): ReviewResult {
	const findings: Finding[] = [];
	for (const { finding } of inputFindings(results)) {
		const index = findings.findIndex((kept) => overlaps(kept, finding));
		const existing = index === -1 ? undefined : findings[index];
		if (!existing) findings.push(finding);
		else if (existing.severity === "suggestion" && finding.severity === "needs_fixing") {
			findings[index] = finding;
		}
	}
	const summary = results
		.map(({ reviewer, result }) => `### ${reviewer}\n\n${result.summary}`)
		.join("\n\n");
	return { verdict: mergedVerdict(results, findings), summary: truncate(summary), findings };
}

// Keeps each merged finding on an anchor some reviewer used: exact or
// overlapping anchors pass, a finding in a reviewed file moves to that file's
// nearest input anchor, and a finding in any other file is dropped.
function guardAnchors(findings: readonly Finding[], inputs: readonly Finding[]) {
	let repaired = 0;
	let dropped = 0;
	const kept: Finding[] = [];
	for (const finding of findings) {
		if (inputs.some((input) => overlaps(input, finding))) {
			kept.push(finding);
			continue;
		}
		const samePath = inputs.filter((input) => input.path === finding.path);
		if (samePath.length === 0) {
			dropped++;
			continue;
		}
		const [nearest] = samePath.toSorted(
			(a, b) => Math.abs(a.line - finding.line) - Math.abs(b.line - finding.line),
		);
		if (!nearest) continue;
		repaired++;
		const { startLine: _drop, ...rest } = finding;
		kept.push({
			...rest,
			line: nearest.line,
			side: nearest.side,
			...(nearest.startLine === undefined ? {} : { startLine: nearest.startLine }),
		});
	}
	return { findings: kept, repaired, dropped };
}

/** Appends a short footer to the review body, keeping the body within the summary limit. */
export function withReviewFooter(result: ReviewResult, footer: string): ReviewResult {
	const suffix = `\n\n---\n${footer}`;
	const room = SUMMARY_LIMIT - suffix.length;
	const body =
		result.summary.length <= room ? result.summary : `${result.summary.slice(0, room - 1)}…`;
	return { ...result, summary: `${body}${suffix}` };
}

export async function mergeReviews(
	results: readonly ReviewerResult[],
	merge: (prompt: string) => Promise<unknown>,
	options: MergeOptions = {},
): Promise<MergeOutcome> {
	const [only] = results;
	if (results.length === 1 && only) {
		return {
			result: {
				...only.result,
				summary: truncate(`${only.result.summary}\n\n${UNAVAILABLE_NOTE}`),
			},
			source: "single",
			repairedAnchors: 0,
			droppedAnchors: 0,
			uncoveredInputs: [],
		};
	}
	if (results.length === 0) throw new Error("mergeReviews needs at least one review");

	const inputs = inputFindings(results);
	const fallback = (error: string): MergeOutcome => {
		const result = fallbackMerge(results);
		return {
			result,
			source: "fallback",
			repairedAnchors: 0,
			droppedAnchors: 0,
			uncoveredInputs: inputs.filter(
				({ finding }) => !result.findings.some((kept) => overlaps(kept, finding)),
			),
			error,
		};
	};

	let raw: unknown;
	try {
		raw = await merge(buildMergePrompt(results, options));
	} catch (error) {
		return fallback(error instanceof Error ? error.message : String(error));
	}
	const parsed = v.safeParse(reviewResultSchema, raw);
	if (!parsed.success) {
		return fallback(`merge output failed validation: ${parsed.issues[0]?.message ?? "invalid"}`);
	}

	const guarded = guardAnchors(
		parsed.output.findings,
		inputs.map(({ finding }) => finding),
	);
	return {
		result: {
			verdict: mergedVerdict(results, guarded.findings),
			summary: truncate(parsed.output.summary),
			findings: guarded.findings,
		},
		source: "merged",
		repairedAnchors: guarded.repaired,
		droppedAnchors: guarded.dropped,
		uncoveredInputs: inputs.filter(
			({ finding }) => !guarded.findings.some((kept) => overlaps(kept, finding)),
		),
	};
}

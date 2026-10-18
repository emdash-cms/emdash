// Trusted-code limits on what a review posts: at most a few suggestions in
// every review, and in a scoped follow-up review, nothing new about code that
// did not change since the last reviewed head.

import type { ReviewResult } from "./review-schema.js";

type Finding = ReviewResult["findings"][number];

export const DEFAULT_MAX_SUGGESTIONS = 3;
export const MISSED_EARLIER_PREFIX =
	"**Missed in the earlier review:** this code has not changed since the last reviewed head.";

const DIFF_FILE = /^diff --git a\/.+ b\/(.+)$/;
const NEW_FILE = /^\+\+\+ (?:b\/(.+)|\/dev\/null)$/;
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export const DEFAULT_FOLLOW_UP_MAX_LINES = 1_000;

export function followUpMaxLines(env: { readonly REVIEW_FOLLOWUP_MAX_LINES?: string }): number {
	const limit = Number(env.REVIEW_FOLLOWUP_MAX_LINES);
	return Number.isInteger(limit) && limit >= 0 ? limit : DEFAULT_FOLLOW_UP_MAX_LINES;
}

export function maxSuggestions(env: { readonly REVIEW_MAX_SUGGESTIONS?: string }): number {
	const limit = Number(env.REVIEW_MAX_SUGGESTIONS);
	return Number.isInteger(limit) && limit >= 0 ? limit : DEFAULT_MAX_SUGGESTIONS;
}

/**
 * Lines of each file, numbered in the new version, that a unified diff adds or
 * changes. A pure deletion marks the line that now sits where the deleted lines
 * were.
 */
export type ChangedLines = ReadonlyMap<string, ReadonlySet<number>>;

export function changedLines(diff: string): ChangedLines {
	const changed = new Map<string, Set<number>>();
	let path: string | undefined;
	let line = 0;
	let inHunk = false;
	for (const text of diff.split("\n")) {
		const file = DIFF_FILE.exec(text);
		if (file) {
			path = file[1];
			inHunk = false;
			if (path && !changed.has(path)) changed.set(path, new Set());
			continue;
		}
		const newFile = NEW_FILE.exec(text);
		if (newFile && !inHunk) {
			path = newFile[1];
			if (path && !changed.has(path)) changed.set(path, new Set());
			continue;
		}
		const hunk = HUNK.exec(text);
		if (hunk) {
			line = Number(hunk[1]);
			inHunk = true;
			continue;
		}
		if (!inHunk || !path) continue;
		const lines = changed.get(path);
		if (text.startsWith("+")) {
			lines?.add(line);
			line++;
		} else if (text.startsWith("-")) {
			lines?.add(line);
		} else if (text.startsWith(" ")) {
			line++;
		} else if (!text.startsWith("\\")) {
			inHunk = false;
		}
	}
	return changed;
}

function touchesChange(finding: Finding, changed: ChangedLines): boolean {
	const lines = changed.get(finding.path);
	if (!lines) return false;
	// LEFT anchors number the base version, which the inter-head diff does not.
	if (finding.side === "LEFT") return true;
	for (let line = finding.startLine ?? finding.line; line <= finding.line; line++) {
		if (lines.has(line)) return true;
	}
	return false;
}

export interface ScopeOutcome {
	readonly result: ReviewResult;
	/** Suggestions dropped because they are about code that did not change. */
	readonly droppedOutsideChange: number;
	/** needs_fixing findings outside the change, kept and marked as missed earlier. */
	readonly markedMissedEarlier: number;
	/** Suggestions dropped over the per-review limit. */
	readonly droppedOverLimit: number;
}

/**
 * Applies the suggestion limit to every review and, when `changed` is given,
 * the follow-up scope. In a follow-up review the verdict approves once no
 * needs_fixing finding remains.
 */
export function scopeReview(
	result: ReviewResult,
	options: { readonly changed?: ChangedLines; readonly maxSuggestions: number },
): ScopeOutcome {
	let droppedOutsideChange = 0;
	let markedMissedEarlier = 0;
	let droppedOverLimit = 0;
	let suggestions = 0;
	const findings: Finding[] = [];
	for (const finding of result.findings) {
		const inScope = !options.changed || touchesChange(finding, options.changed);
		if (finding.severity === "needs_fixing") {
			if (inScope) findings.push(finding);
			else {
				markedMissedEarlier++;
				findings.push({ ...finding, body: `${MISSED_EARLIER_PREFIX}\n\n${finding.body}` });
			}
			continue;
		}
		if (!inScope) {
			droppedOutsideChange++;
			continue;
		}
		if (suggestions >= options.maxSuggestions) {
			droppedOverLimit++;
			continue;
		}
		suggestions++;
		findings.push(finding);
	}
	const blocking = findings.some((finding) => finding.severity === "needs_fixing");
	const verdict = !options.changed
		? result.verdict
		: !blocking
			? "approve"
			: result.verdict === "request_changes"
				? "request_changes"
				: "comment";
	return {
		result: { ...result, verdict, findings },
		droppedOutsideChange,
		markedMissedEarlier,
		droppedOverLimit,
	};
}

/** Added plus deleted lines in a unified diff, counting only `files`. */
export function changedLineCount(diff: string, files: ReadonlySet<string>): number {
	let path: string | undefined;
	let inHunk = false;
	let count = 0;
	for (const text of diff.split("\n")) {
		const file = DIFF_FILE.exec(text);
		if (file) {
			path = file[1];
			inHunk = false;
			continue;
		}
		if (HUNK.test(text)) {
			inHunk = true;
			continue;
		}
		if (!inHunk || !path || !files.has(path)) continue;
		if (
			(text.startsWith("+") || text.startsWith("-")) &&
			!text.startsWith("+++") &&
			!text.startsWith("---")
		) {
			count++;
		}
	}
	return count;
}

export type FollowUpScope =
	| { readonly scoped: true; readonly changed: ChangedLines; readonly lines: number }
	| { readonly scoped: false; readonly lines: number };

/**
 * Whether a follow-up stays scoped: a change since the last reviewed head over
 * `maxLines` changed lines in the PR's files gets a full review instead.
 */
export function followUpScope(
	prDiff: string,
	followUpDiff: string,
	maxLines: number,
): FollowUpScope {
	const prFiles = changedLines(prDiff);
	const lines = changedLineCount(followUpDiff, new Set(prFiles.keys()));
	if (lines > maxLines) return { scoped: false, lines };
	return {
		scoped: true,
		lines,
		changed: new Map([...changedLines(followUpDiff)].filter(([path]) => prFiles.has(path))),
	};
}

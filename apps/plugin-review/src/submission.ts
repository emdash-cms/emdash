import {
	REVIEW_CATEGORIES,
	SEVERITIES,
	type Citation,
	type ReviewCategory,
	type ReviewFinding,
	type Severity,
} from "./types.js";
import type { BundleWorkspace } from "./workspace.js";

const MAX_FINDINGS = 16;
const MAX_CITATIONS = 8;
const MAX_SUMMARY_LENGTH = 1_000;
const MIN_QUOTE_LENGTH = 3;
const MAX_QUOTE_LENGTH = 300;

export interface Submission {
	summary: string;
	findings: ReviewFinding[];
}

/**
 * Checks a `submit_review` call. Returns the problems to send back to the
 * model, or the accepted submission.
 */
export function checkSubmission(
	value: unknown,
	workspace: BundleWorkspace,
): { submission: Submission } | { problems: string[] } {
	const problems: string[] = [];
	const unread = workspace.unreadRanges();
	if (unread.length > 0) {
		problems.push(`Read every text file in full before submitting. Unread: ${unread.join("; ")}.`);
	}
	if (
		!isRecord(value) ||
		typeof value["summary"] !== "string" ||
		!Array.isArray(value["findings"])
	) {
		return {
			problems: [...problems, "submit_review needs a summary string and a findings array."],
		};
	}
	if (value["findings"].length > MAX_FINDINGS) {
		problems.push(`Report at most ${MAX_FINDINGS} findings; merge related ones.`);
	}
	const findings: ReviewFinding[] = [];
	value["findings"].slice(0, MAX_FINDINGS).forEach((raw, index) => {
		const finding = checkFinding(raw, `findings[${index}]`, workspace, problems);
		if (finding) findings.push(finding);
	});
	if (problems.length > 0) return { problems };
	return { submission: { summary: value["summary"].slice(0, MAX_SUMMARY_LENGTH), findings } };
}

function checkFinding(
	raw: unknown,
	field: string,
	workspace: BundleWorkspace,
	problems: string[],
): ReviewFinding | undefined {
	if (!isRecord(raw)) {
		problems.push(`${field} must be an object.`);
		return undefined;
	}
	const { category, severity, confidence, summary, evidence } = raw;
	const before = problems.length;
	if (!isCategory(category))
		problems.push(`${field}.category must be one of ${REVIEW_CATEGORIES.join(", ")}.`);
	if (!isSeverity(severity))
		problems.push(`${field}.severity must be one of ${SEVERITIES.join(", ")}.`);
	if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) {
		problems.push(`${field}.confidence must be a number from 0 to 1.`);
	}
	if (typeof summary !== "string" || summary.trim().length === 0) {
		problems.push(`${field}.summary must describe the finding.`);
	}
	if (!Array.isArray(evidence) || evidence.length === 0 || evidence.length > MAX_CITATIONS) {
		problems.push(`${field}.evidence must cite between 1 and ${MAX_CITATIONS} lines.`);
	}
	const citations: Citation[] = [];
	if (Array.isArray(evidence)) {
		evidence.slice(0, MAX_CITATIONS).forEach((citation, index) => {
			const checked = checkCitation(citation, `${field}.evidence[${index}]`, workspace, problems);
			if (checked) citations.push(checked);
		});
	}
	if (
		problems.length > before ||
		!isCategory(category) ||
		!isSeverity(severity) ||
		typeof confidence !== "number" ||
		typeof summary !== "string"
	) {
		return undefined;
	}
	return {
		category,
		severity,
		confidence,
		summary: summary.trim().slice(0, MAX_SUMMARY_LENGTH),
		evidence: citations,
	};
}

function checkCitation(
	raw: unknown,
	field: string,
	workspace: BundleWorkspace,
	problems: string[],
): Citation | undefined {
	const file = isRecord(raw) ? raw["file"] : undefined;
	const line = isRecord(raw) ? raw["line"] : undefined;
	const quote = isRecord(raw) ? raw["quote"] : undefined;
	if (typeof file !== "string" || typeof line !== "number" || typeof quote !== "string") {
		problems.push(`${field} needs file, line and quote.`);
		return undefined;
	}
	const text = workspace.line(file, line);
	if (text === undefined) {
		problems.push(`${field}: ${file} has no line ${line}.`);
		return undefined;
	}
	const trimmed = quote.trim();
	if (trimmed.length < MIN_QUOTE_LENGTH || trimmed.length > MAX_QUOTE_LENGTH) {
		problems.push(
			`${field}.quote must be ${MIN_QUOTE_LENGTH} to ${MAX_QUOTE_LENGTH} characters copied from the line.`,
		);
		return undefined;
	}
	if (!text.includes(trimmed)) {
		problems.push(`${field}: the quote does not appear on ${file} line ${line}.`);
		return undefined;
	}
	return { file, line, quote: trimmed };
}

function isCategory(value: unknown): value is ReviewCategory {
	return REVIEW_CATEGORIES.some((category) => category === value);
}

function isSeverity(value: unknown): value is Severity {
	return SEVERITIES.some((severity) => severity === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

import {
	isCodeFindingCategory,
	isModerationFindingCategory,
	type CodeFindingCategory,
	type ModerationFindingCategory,
} from "./policy.js";
import { record, runtimeSchema, stringArray, stringValue } from "./schema.js";

export const FINDING_SEVERITIES = ["low", "medium", "high", "critical"] as const;

export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export type AssessmentFindingCategory = ModerationFindingCategory | CodeFindingCategory;

export interface NormalizedModerationFinding<
	Category extends AssessmentFindingCategory = ModerationFindingCategory,
> {
	category: Category;
	recommendation: "none" | "review";
	confidence: number;
	summary: string;
	evidenceRefs: string[];
	severity?: FindingSeverity;
}

export interface ModerationCoverage {
	text: "complete" | "not-present" | "unavailable";
	links: "complete" | "not-present" | "unavailable";
	media: "complete" | "not-present" | "partial" | "unavailable";
	code?: "complete" | "unavailable";
}

export function isFindingSeverity(value: unknown): value is FindingSeverity {
	return FINDING_SEVERITIES.some((severity) => severity === value);
}

function parseFinding<Category extends AssessmentFindingCategory>(
	value: unknown,
	isCategory: (category: unknown) => category is Category,
	allowSeverity: boolean,
): NormalizedModerationFinding<Category> {
	const finding = record(value, "finding", [
		"category",
		"recommendation",
		"confidence",
		"summary",
		"evidenceRefs",
		...(allowSeverity ? ["severity"] : []),
	]);
	const category = finding["category"];
	if (!isCategory(category)) {
		throw new TypeError("finding.category is not recognized");
	}
	if (finding["recommendation"] !== "none" && finding["recommendation"] !== "review") {
		throw new TypeError("finding.recommendation must be none or review");
	}
	if (
		typeof finding["confidence"] !== "number" ||
		!Number.isFinite(finding["confidence"]) ||
		finding["confidence"] < 0 ||
		finding["confidence"] > 1
	) {
		throw new TypeError("finding.confidence must be between zero and one");
	}
	const severity = finding["severity"];
	if (severity !== undefined && !isFindingSeverity(severity)) {
		throw new TypeError("finding.severity is not recognized");
	}
	return {
		category,
		recommendation: finding["recommendation"],
		confidence: finding["confidence"],
		summary: stringValue(finding["summary"], "finding.summary", 500),
		evidenceRefs: stringArray(finding["evidenceRefs"], "finding.evidenceRefs", 32),
		...(severity === undefined ? {} : { severity }),
	};
}

function isAssessmentFindingCategory(value: unknown): value is AssessmentFindingCategory {
	return isModerationFindingCategory(value) || isCodeFindingCategory(value);
}

export const NormalizedModerationFindingSchema = runtimeSchema((value) =>
	parseFinding(value, isModerationFindingCategory, false),
);

/** Accepts listing-metadata findings and findings about a release's package code. */
export const AssessmentFindingSchema = runtimeSchema((value) =>
	parseFinding(value, isAssessmentFindingCategory, true),
);

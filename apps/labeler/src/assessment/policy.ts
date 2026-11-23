import {
	type AssessmentFindingCategory,
	type ListingModerationPolicy,
	type ModerationCoverage,
	type NormalizedModerationFinding,
} from "@emdash-cms/registry-moderation";

import type { ModerationInferenceResult, ModerationModelIdentity } from "../ai/types.js";
import type {
	CodeAssessmentIdentity,
	CodeAssessmentResult,
	CodeReviewReport,
} from "../code/assessment.js";
import type { FindingProvenance } from "../code/integrity.js";
import type { CheckedModerationLink } from "./links.js";

export const ASSESSMENT_POLICY_ENGINE_VERSION = "listing-assessment-policy-v1";

export type AssessmentFinding = NormalizedModerationFinding<AssessmentFindingCategory> &
	FindingProvenance;

export const LINK_CHECK_SOURCE = "link-check";

export interface FailedModerationStage {
	status: "error";
	code: string;
}

export interface CompletedModerationStage {
	status: "complete";
	result: ModerationInferenceResult;
}

export type ModerationStage = CompletedModerationStage | FailedModerationStage;

export type CodeAssessmentStage =
	| { status: "complete"; result: CodeAssessmentResult }
	| (FailedModerationStage & {
			/** Findings from checks that completed before the stage failed. */
			findings?: CodeAssessmentResult["findings"];
	  });

export interface AssessmentPolicyInput {
	policy: ListingModerationPolicy;
	expectedTextRefs: readonly string[];
	expectedLinkRefs: readonly string[];
	expectedMediaRefs: readonly string[];
	checkedLinks: readonly CheckedModerationLink[];
	text?: ModerationStage;
	images: Readonly<Record<string, ModerationStage>>;
	/** Present only when the release requires code assessment. */
	code?: CodeAssessmentStage;
}

export type AssessmentPolicyOutcome = "pass" | "review" | "error";

export interface AssessmentPolicyResolution {
	policyEngineVersion: string;
	policyVersion: string;
	outcome: AssessmentPolicyOutcome;
	coverage: ModerationCoverage;
	findings: readonly AssessmentFinding[];
	reasonCodes: readonly string[];
	textIdentity?: ModerationModelIdentity;
	imageIdentities: readonly ModerationModelIdentity[];
	codeIdentity?: CodeAssessmentIdentity;
	codeReviews?: readonly CodeReviewReport[];
}

export function resolveAssessmentPolicy(input: AssessmentPolicyInput): AssessmentPolicyResolution {
	assertExpectedRefs(input);
	const textRefs = new Set(input.expectedTextRefs);
	const linkRefs = new Set(input.expectedLinkRefs);
	const mediaRefs = new Set(input.expectedMediaRefs);
	const textCoverage = stageCoverage(input.text, textRefs, linkRefs);
	const mediaCoverage = imageCoverage(input.images, mediaRefs);
	const coverage: ModerationCoverage = {
		text: coverageValue(textRefs.size, textCoverage.text),
		links: coverageValue(linkRefs.size, textCoverage.links),
		media: mediaCoverageValue(mediaRefs.size, mediaCoverage.covered, mediaCoverage.failed),
		...(input.code === undefined
			? {}
			: { code: input.code.status === "complete" ? "complete" : "unavailable" }),
	};
	const deterministicFindings = input.checkedLinks.flatMap((link) =>
		link.issues.length === 0
			? []
			: [
					{
						category: "malicious-or-deceptive-link" as const,
						source: LINK_CHECK_SOURCE,
						recommendation: "review" as const,
						confidence: 1,
						summary: `Displayed link failed the link check: ${link.issues.join(", ")}.`,
						evidenceRefs: [link.ref],
					},
				],
	);
	const completedResults = [
		...(input.text?.status === "complete" ? [input.text.result] : []),
		...Object.values(input.images).flatMap((stage) =>
			stage.status === "complete" ? [stage.result] : [],
		),
	];
	const findings = [
		...deterministicFindings,
		...completedResults.flatMap((result) =>
			result.findings.map((finding) => ({ source: result.identity.modelId, ...finding })),
		),
		...(input.code?.status === "complete"
			? input.code.result.findings
			: (input.code?.findings ?? [])),
	];
	const imageIdentities = uniqueIdentities(
		Object.values(input.images).flatMap((stage) =>
			stage.status === "complete" ? [stage.result.identity] : [],
		),
	);
	const textIdentity = input.text?.status === "complete" ? input.text.result.identity : undefined;
	const failures = [
		...(input.text?.status === "error" ? [`text:${input.text.code}`] : []),
		...Object.entries(input.images).flatMap(([ref, stage]) =>
			stage.status === "error" ? [`image:${ref}:${stage.code}`] : [],
		),
		...(input.code?.status === "error" ? [`code:${input.code.code}`] : []),
	];
	const missingRequiredCoverage =
		coverage.text === "unavailable" ||
		coverage.links === "unavailable" ||
		coverage.media === "partial" ||
		coverage.media === "unavailable" ||
		coverage.code === "unavailable";
	if (failures.length > 0 || missingRequiredCoverage) {
		return resolution(
			input,
			"error",
			coverage,
			findings,
			["required-coverage-unavailable", ...failures],
			textIdentity,
			imageIdentities,
		);
	}
	if (findings.length > 0) {
		return resolution(
			input,
			"review",
			coverage,
			findings,
			["policy-finding"],
			textIdentity,
			imageIdentities,
		);
	}
	if (input.policy.autoPass === "disabled") {
		return resolution(
			input,
			"review",
			coverage,
			[],
			["manual-positive-required"],
			textIdentity,
			imageIdentities,
		);
	}
	return resolution(input, "pass", coverage, [], ["automatic-pass"], textIdentity, imageIdentities);
}

function assertExpectedRefs(input: AssessmentPolicyInput): void {
	for (const [name, refs] of [
		["expectedTextRefs", input.expectedTextRefs],
		["expectedLinkRefs", input.expectedLinkRefs],
		["expectedMediaRefs", input.expectedMediaRefs],
	] as const) {
		if (new Set(refs).size !== refs.length) throw new TypeError(`${name} must contain unique refs`);
	}
	const linkInputRefs = new Set(input.checkedLinks.map(({ ref }) => ref));
	if (
		linkInputRefs.size !== input.expectedLinkRefs.length ||
		input.expectedLinkRefs.some((ref) => !linkInputRefs.has(ref))
	) {
		throw new TypeError("checked links must match expected link refs");
	}
	if (Object.keys(input.images).some((ref) => !input.expectedMediaRefs.includes(ref))) {
		throw new TypeError("image results contain an unexpected evidence ref");
	}
}

function stageCoverage(
	stage: ModerationStage | undefined,
	textRefs: ReadonlySet<string>,
	linkRefs: ReadonlySet<string>,
): { text: boolean; links: boolean } {
	if (textRefs.size + linkRefs.size === 0) return { text: true, links: true };
	if (stage?.status !== "complete") return { text: false, links: false };
	const covered = new Set(stage.result.coveredEvidenceRefs);
	return {
		text: [...textRefs].every((ref) => covered.has(ref)),
		links: [...linkRefs].every((ref) => covered.has(ref)),
	};
}

function imageCoverage(
	images: Readonly<Record<string, ModerationStage>>,
	mediaRefs: ReadonlySet<string>,
): { covered: number; failed: boolean } {
	let covered = 0;
	let failed = false;
	for (const ref of mediaRefs) {
		const stage = images[ref];
		if (stage?.status !== "complete") {
			failed ||= stage?.status === "error";
			continue;
		}
		if (!stage.result.coveredEvidenceRefs.includes(ref)) continue;
		covered += 1;
	}
	return { covered, failed };
}

function coverageValue(expected: number, complete: boolean): ModerationCoverage["text"] {
	return expected === 0 ? "not-present" : complete ? "complete" : "unavailable";
}

function mediaCoverageValue(
	expected: number,
	covered: number,
	failed: boolean,
): ModerationCoverage["media"] {
	if (expected === 0) return "not-present";
	if (covered === expected) return "complete";
	if (covered > 0) return "partial";
	return failed ? "unavailable" : "partial";
}

function resolution(
	input: AssessmentPolicyInput,
	outcome: AssessmentPolicyOutcome,
	coverage: ModerationCoverage,
	findings: readonly AssessmentFinding[],
	reasonCodes: readonly string[],
	textIdentity: ModerationModelIdentity | undefined,
	imageIdentities: readonly ModerationModelIdentity[],
): AssessmentPolicyResolution {
	return {
		policyEngineVersion: ASSESSMENT_POLICY_ENGINE_VERSION,
		policyVersion: input.policy.policyVersion,
		outcome,
		coverage,
		findings,
		reasonCodes,
		textIdentity,
		imageIdentities,
		...(input.code?.status === "complete"
			? { codeIdentity: input.code.result.identity, codeReviews: input.code.result.reviews }
			: {}),
	};
}

function uniqueIdentities(
	identities: readonly ModerationModelIdentity[],
): ModerationModelIdentity[] {
	const seen = new Set<string>();
	return identities.filter((identity) => {
		const key = JSON.stringify(identity);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

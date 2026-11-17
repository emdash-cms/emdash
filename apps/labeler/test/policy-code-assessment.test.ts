import { INITIAL_LISTING_POLICY_FIXTURE } from "@emdash-cms/registry-moderation/fixtures";
import { describe, expect, it } from "vitest";

import { resolveAssessmentPolicy, type AssessmentPolicyInput } from "../src/assessment/policy.js";
import type { CodeAssessmentResult } from "../src/code/assessment.js";

const IDENTITY = {
	adapterVersion: "listing-metadata-ai-v1",
	modelId: "candidate",
	promptVersion: "prompt-v1",
	promptHash: "a".repeat(64),
	parameters: {},
};

const CODE_IDENTITY = {
	reviewers: [{ model: "anthropic/claude-opus-5-5", promptVersion: "plugin-review-v1" }],
};

function input(code: AssessmentPolicyInput["code"]): AssessmentPolicyInput {
	return {
		policy: { ...INITIAL_LISTING_POLICY_FIXTURE, autoPass: "assisted" },
		expectedTextRefs: ["release.packageSlug"],
		expectedLinkRefs: [],
		expectedMediaRefs: [],
		checkedLinks: [],
		text: {
			status: "complete",
			result: {
				findings: [],
				coveredEvidenceRefs: ["release.packageSlug"],
				identity: IDENTITY,
				latencyMs: 1,
				usage: {},
			},
		},
		images: {},
		...(code ? { code } : {}),
	};
}

function complete(findings: CodeAssessmentResult["findings"] = []) {
	return {
		status: "complete" as const,
		result: { identity: CODE_IDENTITY, reviews: [], findings },
	};
}

describe("assessment policy with code assessment", () => {
	it("leaves coverage unchanged when code assessment is not required", () => {
		const resolution = resolveAssessmentPolicy(input(undefined));
		expect(resolution.outcome).toBe("pass");
		expect(resolution.coverage).not.toHaveProperty("code");
		expect(resolution).not.toHaveProperty("codeIdentity");
	});

	it("passes a clean review and records the reviewers", () => {
		expect(resolveAssessmentPolicy(input(complete()))).toMatchObject({
			outcome: "pass",
			coverage: { code: "complete" },
			codeIdentity: CODE_IDENTITY,
		});
	});

	it("holds a release with code findings for operator review", () => {
		const finding = {
			category: "malicious-code" as const,
			recommendation: "review" as const,
			confidence: 0.7,
			severity: "high" as const,
			summary: "Sends every post to an undeclared host.",
			evidenceRefs: ["release.package:backend.js#L2"],
		};
		expect(resolveAssessmentPolicy(input(complete([finding])))).toMatchObject({
			outcome: "review",
			reasonCodes: ["policy-finding"],
			findings: [finding],
		});
	});

	it("fails closed when the code stage could not complete", () => {
		expect(
			resolveAssessmentPolicy(input({ status: "error", code: "code-assessment-unavailable" })),
		).toMatchObject({
			outcome: "error",
			coverage: { code: "unavailable" },
			reasonCodes: ["required-coverage-unavailable", "code:code-assessment-unavailable"],
		});
	});
});

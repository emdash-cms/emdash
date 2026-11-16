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
	engineVersion: "code-assessment-engine-v1",
	rulesetId: "emdash-example",
	rulesetVersion: "2026-11-16.1",
	rulesetSha256: "b".repeat(64),
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
		result: { identity: CODE_IDENTITY, findings, truncated: false },
	};
}

describe("assessment policy with code assessment", () => {
	it("leaves coverage unchanged when code assessment is not required", () => {
		const resolution = resolveAssessmentPolicy(input(undefined));
		expect(resolution.outcome).toBe("pass");
		expect(resolution.coverage).not.toHaveProperty("code");
		expect(resolution).not.toHaveProperty("codeIdentity");
	});

	it("passes a clean scan and records the ruleset version", () => {
		expect(resolveAssessmentPolicy(input(complete()))).toMatchObject({
			outcome: "pass",
			coverage: { code: "complete" },
			codeIdentity: CODE_IDENTITY,
		});
	});

	it("holds a release with code findings for operator review", () => {
		const finding = {
			category: "unsafe-code" as const,
			recommendation: "review" as const,
			confidence: 0.7,
			severity: "high" as const,
			summary: "js-dynamic-evaluation: evaluates strings.",
			evidenceRefs: ["release.package:backend.js#L2C9:33-37"],
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

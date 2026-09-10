import { INITIAL_LISTING_POLICY_FIXTURE } from "@emdash-cms/registry-moderation/fixtures";
import { describe, expect, it } from "vitest";

import type { ModerationInferenceResult, ModerationModelIdentity } from "../src/ai/types.js";
import { resolveAssessmentPolicy, type AssessmentPolicyInput } from "../src/assessment/policy.js";

const IDENTITY: ModerationModelIdentity = {
	adapterVersion: "listing-metadata-ai-v1",
	modelId: "candidate",
	promptVersion: "prompt-v1",
	promptHash: "a".repeat(64),
	parameters: { temperature: 0 },
};

function result(refs: readonly string[], findings: ModerationInferenceResult["findings"] = []) {
	return {
		status: "complete" as const,
		result: {
			findings,
			coveredEvidenceRefs: refs,
			identity: IDENTITY,
			latencyMs: 5,
			usage: {},
		},
	};
}

function cleanInput(): AssessmentPolicyInput {
	return {
		policy: INITIAL_LISTING_POLICY_FIXTURE,
		expectedTextRefs: ["profile.name"],
		expectedLinkRefs: ["profile.authors[0].url"],
		expectedMediaRefs: [] as string[],
		checkedLinks: [
			{
				ref: "profile.authors[0].url",
				url: "https://publisher.example",
				usage: "author" as const,
				normalizedUrl: "https://publisher.example/",
				issues: [],
			},
		],
		text: result(["profile.name", "profile.authors[0].url"]),
		images: {},
	};
}

describe("assessment policy resolution", () => {
	it("requires a manual positive decision when automatic moderation is disabled", () => {
		expect(resolveAssessmentPolicy(cleanInput())).toMatchObject({
			outcome: "review",
			reasonCodes: ["manual-positive-required"],
			coverage: { text: "complete", links: "complete", media: "not-present" },
		});
	});

	it("passes clean metadata when assisted automatic moderation is enabled", () => {
		const input = cleanInput();
		input.policy = { ...input.policy, autoPass: "assisted" };
		expect(resolveAssessmentPolicy(input)).toMatchObject({
			outcome: "pass",
			reasonCodes: ["automatic-pass"],
		});
	});

	it("routes findings to review without producing an accusation outcome", () => {
		const input = cleanInput();
		input.text = result(
			["profile.name", "profile.authors[0].url"],
			[
				{
					category: "material-impersonation",
					recommendation: "review",
					confidence: 0.8,
					summary: "Claims to be an official project.",
					evidenceRefs: ["profile.name"],
				},
			],
		);
		expect(resolveAssessmentPolicy(input)).toMatchObject({
			outcome: "review",
			reasonCodes: ["policy-finding"],
		});
	});

	it("fails closed when required inference is unavailable", () => {
		const input = cleanInput();
		input.text = { status: "error", code: "model-timeout" };
		expect(resolveAssessmentPolicy(input)).toMatchObject({
			outcome: "error",
			coverage: { text: "unavailable", links: "unavailable" },
		});
	});
});

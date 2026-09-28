import { describe, expect, it, vi } from "vitest";

import {
	createAssessmentFinalizationProposal,
	finalizeResolvedAssessment,
} from "../src/assessment/finalization.js";
import type { AssessmentPolicyResolution } from "../src/assessment/policy.js";
import type { AssessmentRunSnapshot } from "../src/assessment/types.js";

const RUN: AssessmentRunSnapshot = {
	runKey: "run-1",
	subject: {
		uri: "at://did:plc:listingfixture000000000000/com.emdashcms.experimental.package.profile/gallery",
		cid: "bafyreiabaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibae",
		kind: "profile",
	},
	state: "running",
	stateVersion: 2,
	deleted: false,
};

function resolution(outcome: AssessmentPolicyResolution["outcome"]): AssessmentPolicyResolution {
	return {
		policyEngineVersion: "listing-assessment-policy-v1",
		policyVersion: "listing-metadata-v1",
		outcome,
		coverage: { text: "complete", links: "not-present", media: "not-present" },
		findings: [],
		reasonCodes: [],
		imageIdentities: [],
	};
}

describe("assessment finalization", () => {
	it.each([
		["pass", "passed", "listing-passed"],
		["review", "review", "listing-review"],
		["error", "error", "listing-error"],
	] as const)("binds %s to one exact assessment proposal", (policyOutcome, runOutcome, label) => {
		const proposal = createAssessmentFinalizationProposal({
			run: RUN,
			moderationFingerprint: "f".repeat(64),
			resolution: resolution(policyOutcome),
		});
		expect(proposal).toMatchObject({
			runKey: RUN.runKey,
			assessmentId: RUN.runKey,
			expectedStateVersion: 2,
			subject: RUN.subject,
			outcome: runOutcome,
			label: { subject: RUN.subject, value: label },
		});
	});

	it("rejects a committer response for another CID", async () => {
		const proposal = createAssessmentFinalizationProposal({
			run: RUN,
			moderationFingerprint: "f".repeat(64),
			resolution: resolution("review"),
		});
		const commitAssessmentFinalization = vi.fn(async () => ({
			run: {
				...RUN,
				subject: { ...RUN.subject, cid: "bafywrong" },
				state: "review" as const,
			},
			labelSequence: 1,
			publicationPending: false,
		}));
		await expect(
			finalizeResolvedAssessment({ commitAssessmentFinalization }, proposal),
		).rejects.toThrow("mismatched commit");
	});
});

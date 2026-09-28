import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import {
	ApprovalInvalidationError,
	invalidateApprovalChallenges,
} from "../src/approvals/invalidation.js";

const APPROVER_ONE = "did:plc:approver-one";
const APPROVER_TWO = "did:plc:approver-two";
const PUBLISHER_DID = "did:plc:publisher";
const INTENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const DIGEST = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

async function createChallenge(approverDid: string, challengeHash: string) {
	await env.APPROVER_DO.getByName(approverDid).createChallenge(approverDid, {
		challengeHash,
		kind: "approval",
		intentId: INTENT_ID,
		publisherDid: PUBLISHER_DID,
		approvalDigest: DIGEST,
		context: "approval-context",
		expiresAt: Date.now() + 60_000,
	});
}

afterEach(async () => {
	await reset();
});

describe("approval challenge invalidation", () => {
	it.each([
		"CANCELLED",
		"EXPIRED",
		"PROFILE_CHANGED",
		"BASELINE_CHANGED",
		"ARTIFACT_CHANGED",
		"PROVENANCE_CHANGED",
		"WORKLOAD_CHANGED",
	])("invalidates every approver shard for %s", async (reasonCode) => {
		await createChallenge(APPROVER_ONE, "a".repeat(43));
		await createChallenge(APPROVER_TWO, "b".repeat(43));

		await expect(
			invalidateApprovalChallenges(
				env.APPROVER_DO,
				[APPROVER_ONE, APPROVER_TWO],
				INTENT_ID,
				reasonCode,
			),
		).resolves.toBe(2);
		await expect(
			env.APPROVER_DO.getByName(APPROVER_ONE).consumeChallenge(
				APPROVER_ONE,
				"a".repeat(43),
				"approval",
			),
		).resolves.toEqual({ ok: false, code: "CHALLENGE_CONSUMED" });
	});

	it("rejects duplicate, oversized, malformed, and unknown invalidation input", async () => {
		await expect(
			invalidateApprovalChallenges(
				env.APPROVER_DO,
				[APPROVER_ONE, APPROVER_ONE],
				INTENT_ID,
				"CANCELLED",
			),
		).rejects.toBeInstanceOf(ApprovalInvalidationError);
		await expect(
			invalidateApprovalChallenges(
				env.APPROVER_DO,
				Array.from({ length: 33 }, (_value, index) => `did:plc:approver-${index}`),
				INTENT_ID,
				"CANCELLED",
			),
		).rejects.toBeInstanceOf(ApprovalInvalidationError);
		await expect(
			invalidateApprovalChallenges(env.APPROVER_DO, ["not-a-did"], INTENT_ID, "bad"),
		).rejects.toBeInstanceOf(ApprovalInvalidationError);
	});
});

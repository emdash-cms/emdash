import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import {
	decodeAwaitingApprovalState,
	encodeAwaitingApprovalState,
	type ApprovalEvidence,
} from "../src/approvals/digest.js";
import type {
	CreateIntentInput,
	IntentState,
	PutWorkloadPolicyInput,
	TransitionIntentInput,
} from "../src/publisher-do/publisher-do.js";

const DID = "did:plc:publisher";
const INTENT_1 = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const INTENT_2 = "01JABCDEFGHJKMNPQRSTVWXYZ1";
const NOW = 1_800_000_000_000;
const APPROVER_DID = "did:plc:approver";
const APPROVAL_CHALLENGE = "C".repeat(43);

function publisher() {
	return env.PUBLISHER_DO.getByName(DID);
}

function policy(): PutWorkloadPolicyInput {
	return {
		publisherDid: DID,
		packageSlug: "gallery",
		repository: "emdash-cms/gallery",
		repositoryId: "123456789",
		repositoryOwnerId: "987654321",
		workflowRef: "emdash-cms/gallery/.github/workflows/release.yml@refs/heads/main",
		allowedRefs: ["refs/heads/main"],
		allowedEnvironments: [],
		active: true,
		expectedVersion: null,
		now: NOW,
	};
}

function intent(overrides: Partial<CreateIntentInput> = {}): CreateIntentInput {
	return {
		publisherDid: DID,
		intentId: INTENT_1,
		packageSlug: "gallery",
		version: "1.2.3",
		workloadPolicyVersion: 1,
		workloadIdentityDigest: "A".repeat(43),
		workloadIdempotencyDigest: "I".repeat(43),
		idempotencyKey: "github-run-100-attempt-1",
		requestDigest: "B".repeat(43),
		workloadIdentityJson: JSON.stringify({ issuer: "github-actions", runId: "100" }),
		releaseInputJson: JSON.stringify({ package: "gallery", version: "1.2.3" }),
		expiresAt: NOW + 60_000,
		now: NOW + 1,
		...overrides,
	};
}

function transition(
	expectedState: IntentState,
	expectedGeneration: number,
	toState: IntentState,
	overrides: Partial<TransitionIntentInput> = {},
): TransitionIntentInput {
	return {
		publisherDid: DID,
		intentId: INTENT_1,
		expectedState,
		expectedGeneration,
		toState,
		transitionDigest: String.fromCharCode(66 + expectedGeneration).repeat(43),
		actorRealm: "system",
		actorIdentity: "release-service",
		reasonCode: null,
		stateDataJson: JSON.stringify({ step: toState }),
		now: NOW + 1 + expectedGeneration,
		...overrides,
	};
}

afterEach(async () => {
	await reset();
});

describe("publisher release intents", () => {
	it("atomically reserves a package version and records the received transition", async () => {
		const stub = publisher();
		await stub.putWorkloadPolicy(policy());

		const created = await stub.createIntent(intent());
		expect(created).toMatchObject({
			ok: true,
			replayed: false,
			intent: {
				id: INTENT_1,
				packageSlug: "gallery",
				version: "1.2.3",
				state: "received",
				stateGeneration: 1,
				workloadPolicyVersion: 1,
				workflowId: null,
			},
		});
		await expect(stub.listIntentTransitions(DID, INTENT_1)).resolves.toMatchObject([
			{
				sequence: 1,
				fromState: null,
				toState: "received",
				stateGeneration: 1,
				actorRealm: "oidc",
			},
		]);
	});

	it("records base64url workload digests as OIDC actor identities", async () => {
		const stub = publisher();
		await stub.putWorkloadPolicy(policy());
		await stub.createIntent(intent());
		const actorIdentity = "_".repeat(43);

		await expect(
			stub.transitionIntent(
				transition("received", 1, "cancelled", { actorRealm: "oidc", actorIdentity }),
			),
		).resolves.toMatchObject({ ok: true, intent: { state: "cancelled" } });
		await expect(stub.listIntentTransitions(DID, INTENT_1)).resolves.toMatchObject([
			{},
			{ actorRealm: "oidc", actorIdentity },
		]);
	});

	it("replays identical workload idempotency and rejects changed input", async () => {
		const stub = publisher();
		await stub.putWorkloadPolicy(policy());
		const first = await stub.createIntent(intent());

		await expect(
			stub.createIntent(intent({ intentId: INTENT_2, workloadIdentityDigest: "C".repeat(43) })),
		).resolves.toEqual({
			...(first.ok ? first : {}),
			replayed: true,
		});
		await expect(
			stub.createIntent(intent({ intentId: INTENT_2, requestDigest: "C".repeat(43) })),
		).resolves.toEqual({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
	});

	it("lists newest intents with an exclusive ULID cursor", async () => {
		const stub = publisher();
		await stub.putWorkloadPolicy(policy());
		await stub.createIntent(intent());
		await stub.createIntent(
			intent({
				intentId: INTENT_2,
				version: "1.2.4",
				workloadIdentityDigest: "D".repeat(43),
				workloadIdempotencyDigest: "J".repeat(43),
				idempotencyKey: "github-run-101-attempt-1",
			}),
		);

		await expect(stub.listIntents(DID, null, 1)).resolves.toMatchObject([{ id: INTENT_2 }]);
		await expect(stub.listIntents(DID, INTENT_2, 1)).resolves.toMatchObject([{ id: INTENT_1 }]);
	});

	it("returns the existing owner when another identity reserves the same version", async () => {
		const stub = publisher();
		await stub.putWorkloadPolicy(policy());
		await stub.createIntent(intent());

		await expect(
			stub.createIntent(
				intent({
					intentId: INTENT_2,
					workloadIdentityDigest: "D".repeat(43),
					workloadIdempotencyDigest: "J".repeat(43),
					idempotencyKey: "github-run-101-attempt-1",
				}),
			),
		).resolves.toEqual({
			ok: false,
			code: "RESERVATION_CONFLICT",
			existingIntentId: INTENT_1,
		});
	});

	it("releases an expired reservation for a new intent", async () => {
		const stub = publisher();
		await stub.putWorkloadPolicy(policy());
		await stub.createIntent(intent({ expiresAt: NOW + 10 }));

		await expect(
			stub.createIntent(
				intent({
					intentId: INTENT_2,
					workloadIdentityDigest: "D".repeat(43),
					idempotencyKey: "github-run-101-attempt-1",
					requestDigest: "E".repeat(43),
					expiresAt: NOW + 60_000,
					now: NOW + 11,
				}),
			),
		).resolves.toMatchObject({ ok: true, replayed: false, intent: { id: INTENT_2 } });
		await expect(
			stub.transitionIntent(transition("received", 1, "verifying", { now: NOW + 12 })),
		).resolves.toEqual({ ok: false, code: "INTENT_TRANSITION_INVALID" });
	});

	it("keeps an expired publishing intent reserved until reconciliation finishes", async () => {
		const stub = publisher();
		await stub.putWorkloadPolicy(policy());
		await stub.createIntent(intent({ expiresAt: NOW + 10 }));
		await stub.transitionIntent(transition("received", 1, "verifying"));
		await stub.transitionIntent(transition("verifying", 2, "verified"));
		await stub.transitionIntent(transition("verified", 3, "ready"));
		await stub.transitionIntent(transition("ready", 4, "publishing"));

		await expect(
			stub.createIntent(
				intent({
					intentId: INTENT_2,
					workloadIdentityDigest: "D".repeat(43),
					idempotencyKey: "github-run-101-attempt-1",
					requestDigest: "E".repeat(43),
					expiresAt: NOW + 60_000,
					now: NOW + 11,
				}),
			),
		).resolves.toEqual({
			ok: false,
			code: "RESERVATION_CONFLICT",
			existingIntentId: INTENT_1,
		});
		await expect(
			stub.transitionIntent(transition("publishing", 5, "reconciling", { now: NOW + 12 })),
		).resolves.toMatchObject({ ok: true, intent: { state: "reconciling" } });
		await expect(
			stub.transitionIntent(transition("reconciling", 6, "published", { now: NOW + 13 })),
		).resolves.toMatchObject({ ok: true, intent: { state: "published" } });
	});

	it("releases a terminal unpublished reservation for a new intent", async () => {
		const stub = publisher();
		await stub.putWorkloadPolicy(policy());
		await stub.createIntent(intent());
		await stub.transitionIntent(transition("received", 1, "cancelled"));

		await expect(
			stub.createIntent(
				intent({
					intentId: INTENT_2,
					workloadIdentityDigest: "D".repeat(43),
					idempotencyKey: "github-run-101-attempt-1",
					requestDigest: "E".repeat(43),
				}),
			),
		).resolves.toMatchObject({ ok: true, replayed: false, intent: { id: INTENT_2 } });
	});

	it("requires the exact active workload policy version", async () => {
		const stub = publisher();
		await stub.putWorkloadPolicy(policy());

		await expect(stub.createIntent(intent({ workloadPolicyVersion: 2 }))).resolves.toEqual({
			ok: false,
			code: "WORKLOAD_POLICY_UNAVAILABLE",
		});
		await stub.putWorkloadPolicy({ ...policy(), active: false, expectedVersion: 1, now: NOW + 1 });
		await expect(stub.createIntent(intent())).resolves.toEqual({
			ok: false,
			code: "WORKLOAD_POLICY_UNAVAILABLE",
		});
	});

	it("invalidates outstanding approval challenges when a workload policy changes", async () => {
		const stub = publisher();
		await stub.putWorkloadPolicy(policy());
		await stub.createIntent(intent());
		await stub.transitionIntent(transition("received", 1, "verifying"));
		await stub.transitionIntent(transition("verifying", 2, "verified"));
		const evidence: ApprovalEvidence = {
			intentId: INTENT_1,
			publisherDid: DID,
			packageSlug: "gallery",
			version: "1.2.3",
			verificationGeneration: 4,
			workloadIdentityDigest: "A".repeat(43),
			releaseInputDigest: "B".repeat(43),
			profileCid: "bafyprofile",
			baselineReleaseCid: null,
			artifactChecksum: "sha256:artifact",
			provenanceChecksum: "sha256:provenance",
			declaredAccessDiffDigest: "D".repeat(43),
			verificationDigest: "E".repeat(43),
		};
		const approvalState = await encodeAwaitingApprovalState(evidence, [APPROVER_DID]);
		const approval = await decodeAwaitingApprovalState(approvalState);
		await stub.transitionIntent(
			transition("verified", 3, "awaiting_approval", {
				reasonCode: "APPROVAL_REQUIRED",
				stateDataJson: approvalState,
			}),
		);
		await env.APPROVER_DO.getByName(APPROVER_DID).createChallenge(APPROVER_DID, {
			challengeHash: APPROVAL_CHALLENGE,
			kind: "approval",
			intentId: INTENT_1,
			publisherDid: DID,
			approvalDigest: approval.approvalEvidenceDigest,
			context: "approval-context",
			expiresAt: NOW + 60_000,
			now: NOW + 4,
		});

		await stub.putWorkloadPolicy({
			...policy(),
			active: false,
			expectedVersion: 1,
			now: NOW + 5,
		});

		await expect(stub.getIntent(DID, INTENT_1)).resolves.toMatchObject({
			state: "invalid",
			stateDataJson: '{"reasonCode":"WORKLOAD_POLICY_CHANGED"}',
		});
		await expect(
			env.APPROVER_DO.getByName(APPROVER_DID).consumeChallenge(
				APPROVER_DID,
				APPROVAL_CHALLENGE,
				"approval",
				NOW + 6,
			),
		).resolves.toEqual({ ok: false, code: "CHALLENGE_CONSUMED" });
	});

	it("enforces explicit generation-guarded transitions and idempotent replay", async () => {
		const stub = publisher();
		await stub.putWorkloadPolicy(policy());
		await stub.createIntent(intent());
		const verifying = transition("received", 1, "verifying", {
			workflowId: "workflow-01JABCDEFGHJKMNPQRSTVWXYZ",
		});

		const first = await stub.transitionIntent(verifying);
		expect(first).toMatchObject({
			ok: true,
			replayed: false,
			intent: { state: "verifying", stateGeneration: 2, workflowId: verifying.workflowId },
		});
		await expect(stub.transitionIntent(verifying)).resolves.toMatchObject({
			ok: true,
			replayed: true,
			intent: { state: "verifying", stateGeneration: 2 },
		});
		await expect(
			stub.transitionIntent({ ...verifying, transitionDigest: "Z".repeat(43) }),
		).resolves.toEqual({ ok: false, code: "INTENT_CAS_REQUIRED" });
		await expect(
			stub.transitionIntent(
				transition("verifying", 2, "verified", {
					workflowId: "different-workflow-id",
				}),
			),
		).resolves.toEqual({ ok: false, code: "INTENT_TRANSITION_INVALID" });
		await expect(stub.transitionIntent(transition("verifying", 2, "published"))).resolves.toEqual({
			ok: false,
			code: "INTENT_TRANSITION_INVALID",
		});
		await stub.transitionIntent(transition("verifying", 2, "verified"));
		await expect(stub.transitionIntent(verifying)).resolves.toEqual({
			ok: false,
			code: "INTENT_CAS_REQUIRED",
		});
	});

	it("completes the approval and reconciliation path and closes terminal state", async () => {
		const stub = publisher();
		await stub.putWorkloadPolicy(policy());
		await stub.createIntent(intent());
		const path: IntentState[] = [
			"verifying",
			"verified",
			"awaiting_approval",
			"ready",
			"publishing",
			"reconciling",
			"published",
		];
		let state: IntentState = "received";
		let generation = 1;
		for (const next of path) {
			const result = await stub.transitionIntent(transition(state, generation, next));
			expect(result).toMatchObject({ ok: true, intent: { state: next } });
			state = next;
			generation += 1;
		}
		await expect(
			stub.transitionIntent(transition("published", generation, "failed")),
		).resolves.toEqual({ ok: false, code: "INTENT_TRANSITION_INVALID" });
		expect(await stub.listIntentTransitions(DID, INTENT_1)).toHaveLength(8);
	});

	it("expires an approval wait from the publisher alarm", async () => {
		const stub = publisher();
		const now = Date.now();
		await stub.putWorkloadPolicy(policy());
		await stub.createIntent(intent({ now, expiresAt: now + 60_000 }));
		await stub.transitionIntent(transition("received", 1, "verifying", { now: now + 1 }));
		await stub.transitionIntent(transition("verifying", 2, "verified", { now: now + 2 }));
		await stub.transitionIntent(
			transition("verified", 3, "awaiting_approval", {
				reasonCode: "APPROVAL_REQUIRED",
				now: now + 3,
			}),
		);
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec("UPDATE intents SET expires_at = ? WHERE id = ?", now - 1, INTENT_1);
		});

		await runDurableObjectAlarm(stub);

		await expect(stub.getIntent(DID, INTENT_1)).resolves.toMatchObject({ state: "expired" });
	});

	it("blocks suspended publishers and rejects noncanonical private input", async () => {
		const stub = publisher();
		await stub.putWorkloadPolicy(policy());
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec("UPDATE publisher SET status = 'suspended' WHERE id = 1");
		});
		await expect(stub.createIntent(intent())).resolves.toEqual({
			ok: false,
			code: "PUBLISHER_SUSPENDED",
		});
		await runInDurableObject(stub, async (instance) => {
			await expect(
				instance.createIntent(intent({ workloadIdentityJson: '{ "runId": "100" }' })),
			).rejects.toMatchObject({ code: "INTENT_INPUT_INVALID" });
		});
	});
});

import { abortAllDurableObjects, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

const PUBLISHER_DID = "did:plc:publisher";
const INTENT_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const NOW = 1_800_000_000_000;

function publisher() {
	return env.PUBLISHER_DO.getByName(PUBLISHER_DID);
}

async function createVerifyingIntent() {
	const stub = publisher();
	await stub.putWorkloadPolicy({
		publisherDid: PUBLISHER_DID,
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
	});
	await stub.createIntent({
		publisherDid: PUBLISHER_DID,
		intentId: INTENT_ID,
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
	});
	await stub.transitionIntent({
		publisherDid: PUBLISHER_DID,
		intentId: INTENT_ID,
		expectedState: "received",
		expectedGeneration: 1,
		toState: "verifying",
		transitionDigest: "C".repeat(43),
		actorRealm: "system",
		actorIdentity: "release-service",
		reasonCode: null,
		stateDataJson: "{}",
		workflowId: INTENT_ID,
		now: NOW + 2,
	});
}

afterEach(async () => {
	await reset();
});

describe("publisher verification steps", () => {
	it("persists one idempotent result for each deterministic step", async () => {
		await createVerifyingIntent();
		const input = {
			publisherDid: PUBLISHER_DID,
			intentId: INTENT_ID,
			name: "authoritative-profile" as const,
			inputDigest: "D".repeat(43),
			resultJson: JSON.stringify({ profileCid: "bafyprofile" }),
			now: NOW + 3,
		};

		await expect(publisher().putVerificationStep(input)).resolves.toMatchObject({
			ok: true,
			replayed: false,
			step: { name: "authoritative-profile", inputDigest: "D".repeat(43) },
		});
		await expect(publisher().putVerificationStep(input)).resolves.toMatchObject({
			ok: true,
			replayed: true,
		});
		await expect(
			publisher().putVerificationStep({
				...input,
				resultJson: JSON.stringify({ profileCid: "other" }),
			}),
		).resolves.toEqual({ ok: false, code: "VERIFICATION_STEP_CONFLICT" });
	});

	it("rejects steps outside their allowed intent state", async () => {
		await createVerifyingIntent();
		await expect(
			publisher().putVerificationStep({
				publisherDid: PUBLISHER_DID,
				intentId: INTENT_ID,
				name: "final-verification",
				inputDigest: "D".repeat(43),
				resultJson: "{}",
				now: NOW + 3,
			}),
		).resolves.toEqual({ ok: false, code: "INTENT_STATE_INVALID" });
	});

	it("retains authoritative results across object restarts", async () => {
		await createVerifyingIntent();
		await publisher().putVerificationStep({
			publisherDid: PUBLISHER_DID,
			intentId: INTENT_ID,
			name: "release-absence",
			inputDigest: "E".repeat(43),
			resultJson: JSON.stringify({ absent: true }),
			now: NOW + 3,
		});

		await abortAllDurableObjects();
		await expect(
			env.PUBLISHER_DO.getByName(PUBLISHER_DID).listVerificationSteps(PUBLISHER_DID, INTENT_ID),
		).resolves.toEqual([
			{
				name: "release-absence",
				inputDigest: "E".repeat(43),
				resultJson: JSON.stringify({ absent: true }),
				createdAt: NOW + 3,
			},
		]);
	});
});

import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import type { IntentState, PutWorkloadPolicyInput } from "../src/publisher-do/publisher-do.js";

const DID = "did:plc:publisher";
const INTENT_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const NOW = 1_800_000_000_000;

function publisher() {
	return env.PUBLISHER_DO.getByName(DID);
}

function policy(): PutWorkloadPolicyInput {
	return {
		publisherDid: DID,
		packageSlug: "gallery",
		repository: "emdash-cms/gallery",
		repositoryId: "123",
		repositoryOwnerId: "456",
		workflowRef: "emdash-cms/gallery/.github/workflows/release.yml@refs/heads/main",
		allowedRefs: [],
		allowedEnvironments: [],
		active: true,
		expectedVersion: null,
		now: NOW,
	};
}

async function preparePublishing() {
	const stub = publisher();
	await stub.putWorkloadPolicy(policy());
	await stub.createIntent({
		publisherDid: DID,
		intentId: INTENT_ID,
		packageSlug: "gallery",
		version: "1.2.3",
		workloadPolicyVersion: 1,
		workloadIdentityDigest: "A".repeat(43),
		idempotencyKey: "github-run-100-attempt-1",
		requestDigest: "B".repeat(43),
		workloadIdentityJson: '{"issuer":"github-actions"}',
		releaseInputJson: '{"package":"gallery","version":"1.2.3"}',
		expiresAt: NOW + 60_000,
		now: NOW + 1,
	});
	const path = ["verifying", "verified", "ready", "publishing"] as const;
	let state: IntentState = "received";
	let generation = 1;
	for (const next of path) {
		await stub.transitionIntent({
			publisherDid: DID,
			intentId: INTENT_ID,
			expectedState: state,
			expectedGeneration: generation,
			toState: next,
			transitionDigest: String.fromCharCode(66 + generation).repeat(43),
			actorRealm: "system",
			actorIdentity: "release-service",
			reasonCode: null,
			stateDataJson: JSON.stringify({ step: next }),
			...(next === "verifying" ? { workflowId: "workflow-1" } : {}),
			now: NOW + 1 + generation,
		});
		state = next;
		generation += 1;
	}
	return stub;
}

afterEach(async () => {
	await reset();
});

describe("publisher publication operations", () => {
	it("serializes publication with a generation-bound hashed lease", async () => {
		const stub = await preparePublishing();
		const first = await stub.beginPublicationOperation(DID, INTENT_ID, 5, 5_000, NOW + 10);
		expect(first).toMatchObject({
			ok: true,
			lease: { intentId: INTENT_ID, generation: 1, expectedIntentGeneration: 5 },
		});
		if (!first.ok) return;
		await expect(
			stub.beginPublicationOperation(DID, INTENT_ID, 5, 5_000, NOW + 11),
		).resolves.toEqual({
			ok: false,
			code: "PUBLICATION_BUSY",
			retryAt: first.lease.expiresAt,
		});

		const persisted = await runInDurableObject(stub, (_instance, state) =>
			state.storage.sql
				.exec<{ token_hash: string }>(
					"SELECT token_hash FROM publication_operations WHERE intent_id = ?",
					INTENT_ID,
				)
				.one(),
		);
		expect(persisted.token_hash).not.toBe(first.lease.token);
	});

	it("completes a confirmed write atomically and replays the exact completion", async () => {
		const stub = await preparePublishing();
		const started = await stub.beginPublicationOperation(DID, INTENT_ID, 5, 5_000, NOW + 10);
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		const completion = {
			publisherDid: DID,
			intentId: INTENT_ID,
			generation: started.lease.generation,
			token: started.lease.token,
			expectedIntentGeneration: 5,
			completionDigest: "Z".repeat(43),
			outcome: "published" as const,
			resultUri: "at://did:plc:publisher/com.emdashcms.experimental.package.release/gallery:1.2.3",
			resultCid: "bafybeigdyrzt",
			now: NOW + 11,
		};

		await expect(stub.completePublicationOperation(completion)).resolves.toEqual({
			ok: true,
			state: "published",
			stateGeneration: 6,
			replayed: false,
		});
		await expect(stub.completePublicationOperation(completion)).resolves.toEqual({
			ok: true,
			state: "published",
			stateGeneration: 6,
			replayed: true,
		});
		await expect(stub.getIntent(DID, INTENT_ID)).resolves.toMatchObject({
			state: "published",
			stateGeneration: 6,
			stateDataJson: JSON.stringify({
				resultUri: completion.resultUri,
				resultCid: completion.resultCid,
			}),
		});
	});

	it("rejects stale tokens and records ambiguous outcomes for reconciliation", async () => {
		const stub = await preparePublishing();
		const started = await stub.beginPublicationOperation(DID, INTENT_ID, 5, 5_000, NOW + 10);
		expect(started.ok).toBe(true);
		if (!started.ok) return;

		await expect(
			stub.completePublicationOperation({
				publisherDid: DID,
				intentId: INTENT_ID,
				generation: started.lease.generation,
				token: `${"A".repeat(42)}B`,
				expectedIntentGeneration: 5,
				completionDigest: "Y".repeat(43),
				outcome: "ambiguous",
				resultUri: null,
				resultCid: null,
				now: NOW + 11,
			}),
		).resolves.toEqual({ ok: false, code: "PUBLICATION_CAS_REQUIRED" });
		await expect(
			stub.completePublicationOperation({
				publisherDid: DID,
				intentId: INTENT_ID,
				generation: started.lease.generation,
				token: started.lease.token,
				expectedIntentGeneration: 5,
				completionDigest: "Y".repeat(43),
				outcome: "ambiguous",
				resultUri: null,
				resultCid: null,
				now: NOW + 12,
			}),
		).resolves.toMatchObject({ ok: true, state: "reconciling", stateGeneration: 6 });
	});

	it("records a repository conflict as a terminal conflict outcome", async () => {
		const stub = await preparePublishing();
		const started = await stub.beginPublicationOperation(DID, INTENT_ID, 5, 5_000, NOW + 10);
		expect(started.ok).toBe(true);
		if (!started.ok) return;

		await expect(
			stub.completePublicationOperation({
				publisherDid: DID,
				intentId: INTENT_ID,
				generation: started.lease.generation,
				token: started.lease.token,
				expectedIntentGeneration: 5,
				completionDigest: "X".repeat(43),
				outcome: "conflict",
				resultUri: null,
				resultCid: null,
				now: NOW + 11,
			}),
		).resolves.toEqual({
			ok: true,
			state: "conflict",
			stateGeneration: 6,
			replayed: false,
		});
		await expect(stub.getIntent(DID, INTENT_ID)).resolves.toMatchObject({
			state: "conflict",
			stateGeneration: 6,
		});
		const transitions = await stub.listIntentTransitions(DID, INTENT_ID);
		expect(transitions.at(-1)).toMatchObject({
			fromState: "publishing",
			toState: "conflict",
			reasonCode: "RELEASE_CONFLICT",
		});
	});

	it("requires reconciliation and re-arms recovery for an expired write lease", async () => {
		const stub = await preparePublishing();
		await stub.beginPublicationOperation(DID, INTENT_ID, 5, 1, NOW + 10);
		await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());

		await expect(
			stub.beginPublicationOperation(DID, INTENT_ID, 5, 5_000, NOW + 12),
		).resolves.toEqual({ ok: false, code: "PUBLICATION_RECOVERY_REQUIRED" });
		await expect(
			runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
		).resolves.toBe(NOW + 13);
	});

	it("recovers an expired in-flight write into reconciliation via the alarm", async () => {
		const stub = await preparePublishing();
		const alarmNow = Date.now() - 1_000;
		await stub.beginPublicationOperation(DID, INTENT_ID, 5, 1, alarmNow);

		await runDurableObjectAlarm(stub);
		await expect(stub.getIntent(DID, INTENT_ID)).resolves.toMatchObject({
			state: "reconciling",
			stateGeneration: 6,
			stateDataJson: '{"recovery":"operation-expired"}',
		});
		const transitions = await stub.listIntentTransitions(DID, INTENT_ID);
		expect(transitions.at(-1)).toMatchObject({
			fromState: "publishing",
			toState: "reconciling",
			reasonCode: "PDS_AMBIGUOUS",
		});
		const audit = await runInDurableObject(stub, (_instance, state) =>
			state.storage.sql
				.exec<{ event_type: string }>("SELECT event_type FROM audit_events ORDER BY sequence")
				.toArray()
				.map((row) => row.event_type),
		);
		expect(audit).toContain("publication-operation-recovery-required");
	});
});

import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import type { IntentState, PutWorkloadPolicyInput } from "../src/publisher-do/publisher-do.js";
import { digestWorkloadIdentity } from "../src/workload/policy.js";
import type { VerifiedWorkloadIdentity } from "../src/workload/types.js";

const DID = "did:plc:publisher";
const INTENT_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const NOW = 1_800_000_000_000;
const OPERATION_CREDENTIAL = "C".repeat(43);
const ATTEMPT_KEY = "K".repeat(43);
const ATTEMPT_TOKEN = "T".repeat(43);
const CHECKSUM = "bciqb43wwlv35mnso5lwvu5c3uxcjqwxcw4an3boxz57qe667fffdh7a";
const BLOB_CID = "bafkreia6n3lf256wgzhov3k2orn2lreyllrloag5qxl467ycpppsssrt7q";
const SOURCE_URL = "https://example.com/gallery.tar.gz";
const WORKLOAD_IDENTITY: VerifiedWorkloadIdentity = {
	issuer: "github-actions",
	subject: "repo:emdash-cms/gallery:ref:refs/heads/main",
	tokenId: "release-token-100",
	repository: {
		name: "emdash-cms/gallery",
		id: "123",
		owner: "emdash-cms",
		ownerId: "456",
		visibility: "public",
	},
	workflow: {
		ref: "emdash-cms/gallery/.github/workflows/release.yml@refs/heads/main",
		sha: "a".repeat(40),
		jobRef: null,
		jobSha: null,
	},
	run: {
		id: "100",
		attempt: 1,
		actor: "release-bot",
		actorId: "200",
		eventName: "workflow_dispatch",
		ref: "refs/heads/main",
		refType: "branch",
		commitSha: "b".repeat(40),
		environment: null,
		runnerEnvironment: "github-hosted",
	},
	issuedAt: 1_800_000_000,
	expiresAt: 1_800_000_300,
};

function sourceRelease() {
	return {
		$type: "com.emdashcms.experimental.package.release" as const,
		package: "gallery",
		version: "1.2.3",
		artifacts: {
			package: {
				url: SOURCE_URL,
				checksum: CHECKSUM,
				contentType: "application/gzip",
			},
		},
	};
}

function materializedRelease() {
	return {
		...sourceRelease(),
		artifacts: {
			package: {
				checksum: CHECKSUM,
				contentType: "application/gzip",
				blob: {
					$type: "blob" as const,
					ref: { $link: BLOB_CID },
					mimeType: "application/gzip",
					size: 32_768,
				},
			},
		},
	};
}

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
		workloadIdentityDigest: await digestWorkloadIdentity(WORKLOAD_IDENTITY),
		workloadIdempotencyDigest: "I".repeat(43),
		idempotencyKey: "github-run-100-attempt-1",
		requestDigest: "B".repeat(43),
		workloadIdentityJson: JSON.stringify(WORKLOAD_IDENTITY),
		releaseInputJson: JSON.stringify({ release: sourceRelease() }),
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

function beginPublicationOperation(
	stub: ReturnType<typeof publisher>,
	leaseMs: number,
	now: number,
	attemptKey = ATTEMPT_KEY,
	token = ATTEMPT_TOKEN,
) {
	return stub.beginPublicationOperation(DID, INTENT_ID, 5, leaseMs, attemptKey, token, now);
}

async function digest(value: string): Promise<string> {
	const bytes = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
	);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function materialize(stub: ReturnType<typeof publisher>): Promise<string> {
	const sourceDigest = "B".repeat(43);
	await stub.beginPublicationMaterialization(DID, INTENT_ID, sourceDigest, NOW + 6);
	await stub.putPublicationArtifactStage({
		publisherDid: DID,
		intentId: INTENT_ID,
		sourceDigest,
		slot: "package",
		sourceUrlDigest: await digest(SOURCE_URL),
		checksum: CHECKSUM,
		stagingKey: `publication/${INTENT_ID}/package`,
		mimeType: "application/gzip",
		size: 32_768,
		width: null,
		height: null,
		now: NOW + 7,
	});
	await stub.putPublicationBlobReceipt({
		publisherDid: DID,
		intentId: INTENT_ID,
		sourceDigest,
		slot: "package",
		blob: {
			$type: "blob",
			ref: { $link: BLOB_CID },
			mimeType: "application/gzip",
			size: 32_768,
		},
		now: NOW + 8,
	});
	const recordJson = JSON.stringify(materializedRelease());
	const recordDigest = await digest(recordJson);
	await stub.completePublicationMaterialization({
		publisherDid: DID,
		intentId: INTENT_ID,
		sourceDigest,
		recordJson,
		recordDigest,
		now: NOW + 9,
	});
	return recordDigest;
}

async function advanceToCreating(
	stub: ReturnType<typeof publisher>,
	lease: {
		generation: number;
		token: string;
		expectedIntentGeneration: number;
	},
): Promise<string> {
	const materializationDigest = await materialize(stub);
	const base = {
		publisherDid: DID,
		intentId: INTENT_ID,
		generation: lease.generation,
		token: lease.token,
		expectedIntentGeneration: lease.expectedIntentGeneration,
		materializationDigest,
	};
	await stub.advancePublicationOperationPhase({ ...base, phase: "materialized", now: NOW + 10 });
	await stub.advancePublicationOperationPhase({ ...base, phase: "creating", now: NOW + 10 });
	return materializationDigest;
}

async function expireOperation(stub: ReturnType<typeof publisher>): Promise<void> {
	await runInDurableObject(stub, (_instance, state) => {
		const expiredAt = Date.now() - 1;
		state.storage.sql.exec(
			"UPDATE publication_operations SET expires_at = ? WHERE intent_id = ?",
			expiredAt,
			INTENT_ID,
		);
		state.storage.sql.exec(
			`UPDATE deadlines SET scheduled_at = ?
			 WHERE kind = 'publication-operation' AND subject_id = ?`,
			expiredAt,
			INTENT_ID,
		);
	});
}

afterEach(async () => {
	await reset();
});

describe("publisher publication operations", () => {
	it("replays a committed begin after response loss and serializes other attempts", async () => {
		const stub = await preparePublishing();
		const first = await beginPublicationOperation(stub, 5_000, NOW + 10);
		expect(first).toMatchObject({
			ok: true,
			replayed: false,
			lease: { intentId: INTENT_ID, generation: 1, expectedIntentGeneration: 5 },
		});
		if (!first.ok) return;
		await expect(beginPublicationOperation(stub, 5_000, NOW + 11)).resolves.toEqual({
			ok: true,
			lease: first.lease,
			replayed: true,
		});
		await expect(
			beginPublicationOperation(stub, 5_000, NOW + 11, OPERATION_CREDENTIAL, "U".repeat(43)),
		).resolves.toEqual({
			ok: false,
			code: "PUBLICATION_BUSY",
			retryAt: first.lease.expiresAt,
		});
		await expect(stub.getIntent(DID, INTENT_ID)).resolves.toMatchObject({ state: "publishing" });

		const persisted = await runInDurableObject(stub, (_instance, state) =>
			state.storage.sql
				.exec<{ attempt_key: string; token_hash: string }>(
					"SELECT attempt_key, token_hash FROM publication_operations WHERE intent_id = ?",
					INTENT_ID,
				)
				.one(),
		);
		expect(persisted.attempt_key).toBe(ATTEMPT_KEY);
		expect(persisted.token_hash).not.toBe(first.lease.token);
	});

	it("advances materialized and creating phases only for the active lease", async () => {
		const stub = await preparePublishing();
		const started = await beginPublicationOperation(stub, 5_000, NOW + 10);
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
				outcome: "ambiguous",
				resultUri: null,
				resultCid: null,
				now: NOW + 11,
			}),
		).resolves.toEqual({ ok: false, code: "PUBLICATION_CAS_REQUIRED" });
		const materializationDigest = await materialize(stub);
		const input = {
			publisherDid: DID,
			intentId: INTENT_ID,
			generation: started.lease.generation,
			token: started.lease.token,
			expectedIntentGeneration: 5,
			materializationDigest,
			phase: "materialized" as const,
			now: NOW + 11,
		};
		await expect(
			stub.advancePublicationOperationPhase({ ...input, token: `${"A".repeat(42)}B` }),
		).resolves.toEqual({ ok: false, code: "PUBLICATION_CAS_REQUIRED" });
		await expect(stub.advancePublicationOperationPhase(input)).resolves.toEqual({
			ok: true,
			phase: "materialized",
			materializationDigest,
			replayed: false,
		});
		await expect(stub.advancePublicationOperationPhase(input)).resolves.toMatchObject({
			ok: true,
			replayed: true,
		});
		await expect(
			stub.advancePublicationOperationPhase({
				...input,
				materializationDigest: "Z".repeat(43),
			}),
		).resolves.toEqual({ ok: false, code: "PUBLICATION_PHASE_CONFLICT" });
		await expect(
			stub.advancePublicationOperationPhase({ ...input, phase: "creating", now: NOW + 12 }),
		).resolves.toMatchObject({ ok: true, phase: "creating", replayed: false });
	});

	it.each([
		["disabled", { active: false }],
		["narrowed", { allowedRefs: ["refs/tags/*"] }],
	] as const)(
		"invalidates a pre-write operation when its workload is %s",
		async (_name, change) => {
			const stub = await preparePublishing();
			const started = await beginPublicationOperation(stub, 5_000, NOW + 10);
			expect(started.ok).toBe(true);
			if (!started.ok) return;
			const materializationDigest = await materialize(stub);
			const phaseInput = {
				publisherDid: DID,
				intentId: INTENT_ID,
				generation: started.lease.generation,
				token: started.lease.token,
				expectedIntentGeneration: started.lease.expectedIntentGeneration,
				materializationDigest,
			};
			await stub.advancePublicationOperationPhase({
				...phaseInput,
				phase: "materialized",
				now: NOW + 11,
			});

			await stub.putWorkloadPolicy({
				...policy(),
				...change,
				expectedVersion: 1,
				now: NOW + 12,
			});

			await expect(stub.getIntent(DID, INTENT_ID)).resolves.toMatchObject({
				state: "invalid",
				stateGeneration: 6,
				stateDataJson: '{"reasonCode":"WORKLOAD_POLICY_CHANGED"}',
			});
			await expect(
				stub.advancePublicationOperationPhase({
					...phaseInput,
					phase: "creating",
					now: NOW + 13,
				}),
			).resolves.toEqual({ ok: false, code: "PUBLICATION_CAS_REQUIRED" });
		},
	);

	it.each([
		["inactive version", "UPDATE workload_policies SET active = 0, state_version = 2"],
		["narrowed current rules", `UPDATE workload_policies SET allowed_refs = '["refs/tags/*"]'`],
		["stored identity digest", `UPDATE intents SET workload_identity_digest = '${"A".repeat(43)}'`],
		[
			"canonical stored identity",
			`UPDATE intents SET workload_identity_json = '{"issuer":"github-actions"}'`,
		],
	] as const)("rechecks the %s at the atomic creating gate", async (_name, policyUpdate) => {
		const stub = await preparePublishing();
		const started = await beginPublicationOperation(stub, 5_000, NOW + 10);
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		const materializationDigest = await materialize(stub);
		const phaseInput = {
			publisherDid: DID,
			intentId: INTENT_ID,
			generation: started.lease.generation,
			token: started.lease.token,
			expectedIntentGeneration: started.lease.expectedIntentGeneration,
			materializationDigest,
		};
		await stub.advancePublicationOperationPhase({
			...phaseInput,
			phase: "materialized",
			now: NOW + 11,
		});
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec(policyUpdate);
		});

		await expect(
			stub.advancePublicationOperationPhase({
				...phaseInput,
				phase: "creating",
				now: NOW + 12,
			}),
		).resolves.toEqual({ ok: false, code: "WORKLOAD_POLICY_UNAVAILABLE" });
	});

	it("preserves reconciliation after the creating boundary wins the ordering race", async () => {
		const stub = await preparePublishing();
		const started = await beginPublicationOperation(stub, 5_000, NOW + 10);
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		await advanceToCreating(stub, started.lease);

		await stub.putWorkloadPolicy({
			...policy(),
			active: false,
			expectedVersion: 1,
			now: NOW + 11,
		});

		await expect(stub.getIntent(DID, INTENT_ID)).resolves.toMatchObject({
			state: "publishing",
			stateGeneration: 5,
		});
		await expect(
			stub.completePublicationOperation({
				publisherDid: DID,
				intentId: INTENT_ID,
				generation: started.lease.generation,
				token: started.lease.token,
				expectedIntentGeneration: started.lease.expectedIntentGeneration,
				completionDigest: "Z".repeat(43),
				outcome: "ambiguous",
				resultUri: null,
				resultCid: null,
				now: NOW + 12,
			}),
		).resolves.toMatchObject({ ok: true, state: "reconciling" });
	});

	it("completes a confirmed write atomically and replays the exact completion", async () => {
		const stub = await preparePublishing();
		const started = await beginPublicationOperation(stub, 5_000, NOW + 10);
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		await advanceToCreating(stub, started.lease);
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
		await expect(
			stub.completePublicationOperation({ ...completion, resultCid: "bafyother" }),
		).resolves.toEqual({ ok: false, code: "PUBLICATION_CAS_REQUIRED" });
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
		const started = await beginPublicationOperation(stub, 5_000, NOW + 10);
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
		await advanceToCreating(stub, started.lease);
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
		const started = await beginPublicationOperation(stub, 5_000, NOW + 10);
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		await advanceToCreating(stub, started.lease);

		await expect(
			stub.completePublicationOperation({
				publisherDid: DID,
				intentId: INTENT_ID,
				generation: started.lease.generation,
				token: started.lease.token,
				expectedIntentGeneration: 5,
				completionDigest: "W".repeat(43),
				outcome: "conflict",
				reasonCode: null,
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
		const transitions = await stub.listIntentTransitions(DID, INTENT_ID);
		expect(transitions.at(-1)).toMatchObject({
			fromState: "publishing",
			toState: "conflict",
			reasonCode: "RELEASE_CONFLICT",
		});
	});

	it.each([
		["blocked", "ready", "PUBLICATION_PAUSED"],
		["failed", "failed", "OAUTH_DELEGATION_UNAVAILABLE"],
	] as const)(
		"closes an expired pre-write lease as %s without entering ambiguous reconciliation",
		async (outcome, state, reasonCode) => {
			const stub = await preparePublishing();
			const started = await beginPublicationOperation(stub, 1, NOW + 10);
			expect(started.ok).toBe(true);
			if (!started.ok) return;

			const completion = {
				publisherDid: DID,
				intentId: INTENT_ID,
				generation: started.lease.generation,
				token: started.lease.token,
				expectedIntentGeneration: 5,
				completionDigest: "X".repeat(43),
				outcome,
				reasonCode,
				resultUri: null,
				resultCid: null,
				now: NOW + 12,
			} as const;
			await expect(stub.completePublicationOperation(completion)).resolves.toEqual({
				ok: true,
				state,
				stateGeneration: 6,
				replayed: false,
			});
			await expect(
				stub.completePublicationOperation({ ...completion, reasonCode: "DIFFERENT_REASON" }),
			).resolves.toEqual({ ok: false, code: "PUBLICATION_CAS_REQUIRED" });
			await expect(stub.getIntent(DID, INTENT_ID)).resolves.toMatchObject({
				state,
				stateGeneration: 6,
			});
			const transitions = await stub.listIntentTransitions(DID, INTENT_ID);
			expect(transitions.at(-1)).toMatchObject({ reasonCode, toState: state });
		},
	);

	it.each([
		["blocked", "PUBLICATION_PAUSED"],
		["failed", "OAUTH_DELEGATION_UNAVAILABLE"],
	] as const)("rejects a %s completion after the create boundary", async (outcome, reasonCode) => {
		const stub = await preparePublishing();
		const started = await beginPublicationOperation(stub, 5_000, NOW + 10);
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		await advanceToCreating(stub, started.lease);

		await expect(
			stub.completePublicationOperation({
				publisherDid: DID,
				intentId: INTENT_ID,
				generation: started.lease.generation,
				token: started.lease.token,
				expectedIntentGeneration: started.lease.expectedIntentGeneration,
				completionDigest: "X".repeat(43),
				outcome,
				reasonCode,
				resultUri: null,
				resultCid: null,
				now: NOW + 12,
			}),
		).resolves.toEqual({ ok: false, code: "PUBLICATION_CAS_REQUIRED" });
		await expect(stub.getIntent(DID, INTENT_ID)).resolves.toMatchObject({ state: "publishing" });
	});

	it("requires reconciliation and re-arms recovery for an expired write lease", async () => {
		const stub = await preparePublishing();
		await beginPublicationOperation(stub, 1, NOW + 10);
		await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());

		await expect(
			beginPublicationOperation(stub, 5_000, NOW + 12, "L".repeat(43), "U".repeat(43)),
		).resolves.toEqual({ ok: false, code: "PUBLICATION_RECOVERY_REQUIRED" });
		await expect(
			runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
		).resolves.toBe(NOW + 13);
	});

	it("recovers an expired upload phase back to ready via the alarm", async () => {
		const stub = await preparePublishing();
		const alarmNow = Date.now() - 1_000;
		await beginPublicationOperation(stub, 1, alarmNow);

		await runDurableObjectAlarm(stub);
		await expect(stub.getIntent(DID, INTENT_ID)).resolves.toMatchObject({
			state: "ready",
			stateGeneration: 6,
			stateDataJson: '{"recovery":"operation-expired-before-create"}',
		});
		const transitions = await stub.listIntentTransitions(DID, INTENT_ID);
		expect(transitions.at(-1)).toMatchObject({
			fromState: "publishing",
			toState: "ready",
			reasonCode: "PUBLICATION_RETRY_REQUIRED",
		});
		const audit = await runInDurableObject(stub, (_instance, state) =>
			state.storage.sql
				.exec<{ event_type: string }>("SELECT event_type FROM audit_events ORDER BY sequence")
				.toArray()
				.map((row) => row.event_type),
		);
		expect(audit).toContain("publication-operation-retry-required");
	});

	it("retains materialization and reconciles only after the creating phase expires", async () => {
		const stub = await preparePublishing();
		const started = await beginPublicationOperation(stub, 5_000, NOW + 10);
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		const materializationDigest = await advanceToCreating(stub, started.lease);
		await expireOperation(stub);

		await runDurableObjectAlarm(stub);
		await expect(stub.getIntent(DID, INTENT_ID)).resolves.toMatchObject({
			state: "reconciling",
			stateGeneration: 6,
			stateDataJson: '{"recovery":"operation-expired-after-create"}',
		});
		await expect(stub.getPublicationMaterialization(DID, INTENT_ID)).resolves.toMatchObject({
			status: "complete",
			recordDigest: materializationDigest,
		});
	});

	it("retains materialization but returns an expired materialized phase to ready", async () => {
		const stub = await preparePublishing();
		const started = await beginPublicationOperation(stub, 5_000, NOW + 10);
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		const materializationDigest = await materialize(stub);
		await stub.advancePublicationOperationPhase({
			publisherDid: DID,
			intentId: INTENT_ID,
			generation: started.lease.generation,
			token: started.lease.token,
			expectedIntentGeneration: started.lease.expectedIntentGeneration,
			phase: "materialized",
			materializationDigest,
			now: NOW + 10,
		});
		await expireOperation(stub);

		await runDurableObjectAlarm(stub);
		await expect(stub.getIntent(DID, INTENT_ID)).resolves.toMatchObject({ state: "ready" });
		await expect(stub.getPublicationMaterialization(DID, INTENT_ID)).resolves.toMatchObject({
			status: "complete",
			recordDigest: materializationDigest,
		});
	});
});

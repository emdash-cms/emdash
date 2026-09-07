import { abortAllDurableObjects, reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

const APPROVER_DID = "did:plc:approver";
const OTHER_APPROVER_DID = "did:plc:other";
const PUBLISHER_DID = "did:plc:publisher";
const STATE_HASH = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const TOKEN_HASH = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefg";
const CSRF_HASH = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg";
const CHALLENGE_HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECOND_CHALLENGE_HASH = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const APPROVAL_DIGEST = "ccccccccccccccccccccccccccccccccccccccccccc";
const INTENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CREDENTIAL_ID = "credential-one";
const SECOND_CREDENTIAL_ID = "credential-two";

function approver() {
	return env.APPROVER_DO.getByName(APPROVER_DID);
}

function credentialInput(id = CREDENTIAL_ID, now = 1_800_000_000_000) {
	return {
		credentialId: id,
		publicKey: new Uint8Array([1, 2, 3, 4]),
		algorithm: -7,
		counter: 0,
		transports: ["internal" as const],
		name: id === CREDENTIAL_ID ? "Laptop" : "Security key",
		now,
	};
}

afterEach(async () => {
	await reset();
});

describe("ApproverDurableObject", () => {
	it("binds canonical state to the named approver shard and survives restart", async () => {
		const stub = approver();
		await stub.initializeApprover(APPROVER_DID);
		await stub.enrolCredential(APPROVER_DID, credentialInput());

		await runInDurableObject(stub, async (instance) => {
			expect(() => instance.initializeApprover(OTHER_APPROVER_DID)).toThrowError(
				expect.objectContaining({ code: "APPROVER_DID_MISMATCH" }),
			);
		});

		const unnamed = env.APPROVER_DO.get(env.APPROVER_DO.newUniqueId());
		await runInDurableObject(unnamed, async (instance) => {
			expect(() => instance.initializeApprover(APPROVER_DID)).toThrowError(
				expect.objectContaining({ code: "APPROVER_DID_MISMATCH" }),
			);
		});

		await abortAllDurableObjects();
		await expect(
			env.APPROVER_DO.getByName(APPROVER_DID).listCredentials(APPROVER_DID, null, 10),
		).resolves.toMatchObject([{ id: CREDENTIAL_ID, name: "Laptop" }]);
	});

	it("stores encrypted identity proof state and consumes it exactly once", async () => {
		const stub = approver();
		const now = 1_800_000_000_000;
		const input = {
			approverDid: APPROVER_DID,
			stateHash: STATE_HASH,
			encryptedState: "encrypted-identity-state",
			encryptionKeyVersion: 1,
			clientKeyId: "assertion-1",
			redirectTarget: `/approvals/${INTENT_ID}`,
			expiresAt: now + 60_000,
			now,
		};

		await expect(stub.putIdentityTransaction(input)).resolves.toEqual({ ok: true });
		await expect(stub.putIdentityTransaction(input)).resolves.toEqual({
			ok: false,
			code: "IDENTITY_TRANSACTION_EXISTS",
		});
		await expect(
			stub.consumeIdentityTransaction(APPROVER_DID, STATE_HASH, now + 1),
		).resolves.toMatchObject({
			encryptedState: "encrypted-identity-state",
			clientKeyId: "assertion-1",
			redirectTarget: `/approvals/${INTENT_ID}`,
		});
		await expect(
			stub.consumeIdentityTransaction(APPROVER_DID, STATE_HASH, now + 2),
		).resolves.toBeNull();

		const persisted = await runInDurableObject(stub, (_instance, state) => ({
			identity: state.storage.sql
				.exec<{ encrypted_state: string; completed_at: number | null }>(
					"SELECT encrypted_state, completed_at FROM identity_transactions",
				)
				.one(),
			audit: state.storage.sql
				.exec<{ public_payload: string }>("SELECT public_payload FROM audit_events")
				.toArray(),
		}));
		expect(persisted.identity).toEqual({ encrypted_state: "", completed_at: now + 1 });
		expect(JSON.stringify(persisted.audit)).not.toContain("encrypted-identity-state");
	});

	it("bounds retained identity transaction tombstones", async () => {
		const stub = approver();
		const now = 1_800_000_000_000;
		for (let index = 0; index < 30; index += 1) {
			const stateHash = String(index).padStart(43, "a");
			await stub.putIdentityTransaction({
				approverDid: APPROVER_DID,
				stateHash,
				encryptedState: "encrypted-identity-state",
				encryptionKeyVersion: 1,
				clientKeyId: "assertion-1",
				redirectTarget: "/approver",
				expiresAt: now + 60_000,
				now,
			});
			await stub.consumeIdentityTransaction(APPROVER_DID, stateHash, now + 1);
		}

		await expect(
			runInDurableObject(stub, (_instance, state) =>
				state.storage.sql
					.exec<{ count: number }>("SELECT COUNT(*) AS count FROM identity_transactions")
					.one(),
			),
		).resolves.toEqual({ count: 1 });
	});

	it("rejects expired identity proof state without returning encrypted material", async () => {
		const stub = approver();
		const now = 1_800_000_000_000;
		await stub.putIdentityTransaction({
			approverDid: APPROVER_DID,
			stateHash: STATE_HASH,
			encryptedState: "expired-encrypted-state",
			encryptionKeyVersion: 1,
			clientKeyId: "assertion-1",
			redirectTarget: "/approver",
			expiresAt: now + 1,
			now,
		});

		await expect(
			stub.consumeIdentityTransaction(APPROVER_DID, STATE_HASH, now + 2),
		).resolves.toBeNull();
		await expect(stub.listAuditEvents(APPROVER_DID, 0, 10)).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					eventType: "identity-transaction-expired",
					reasonCode: "IDENTITY_TRANSACTION_EXPIRED",
				}),
			]),
		);
	});

	it("pages live identity ciphertexts and rotates them by compare-and-set", async () => {
		const stub = approver();
		const now = 1_800_000_000_000;
		await stub.putIdentityTransaction({
			approverDid: APPROVER_DID,
			stateHash: STATE_HASH,
			encryptedState: "approver-ciphertext-v1",
			encryptionKeyVersion: 1,
			clientKeyId: "assertion-1",
			redirectTarget: `/approvals/${INTENT_ID}`,
			expiresAt: now + 60_000,
			now,
		});

		await expect(stub.listEncryptionRecords(APPROVER_DID, null, 10, now)).resolves.toEqual({
			items: [
				{
					cursor: `identity-transaction:${STATE_HASH}`,
					envelope: "approver-ciphertext-v1",
					keyVersion: 1,
					context: {
						purpose: "oauth-approver-transaction",
						objectClass: "ApproverDurableObject",
						table: "identity_transactions",
						primaryKey: STATE_HASH,
						ownerDid: APPROVER_DID,
					},
				},
			],
			nextCursor: null,
		});
		await expect(
			stub.replaceEncryptionRecord({
				approverDid: APPROVER_DID,
				cursor: `identity-transaction:${STATE_HASH}`,
				expectedEnvelope: "approver-ciphertext-v1",
				replacementEnvelope: "approver-ciphertext-v2",
				replacementKeyVersion: 2,
				actorIdentity: "operator@example.com",
				now,
			}),
		).resolves.toBe(true);
		await expect(
			stub.replaceEncryptionRecord({
				approverDid: APPROVER_DID,
				cursor: `identity-transaction:${STATE_HASH}`,
				expectedEnvelope: "approver-ciphertext-v1",
				replacementEnvelope: "approver-ciphertext-v3",
				replacementKeyVersion: 3,
				actorIdentity: "operator@example.com",
				now,
			}),
		).resolves.toBe(false);
		await expect(stub.listEncryptionRecords(APPROVER_DID, null, 10, now)).resolves.toMatchObject({
			items: [{ envelope: "approver-ciphertext-v2", keyVersion: 2 }],
		});
		expect(
			await runInDurableObject(stub, (_instance, state) =>
				state.storage.sql
					.exec<{ event_type: string; public_payload: string }>(
						"SELECT event_type, public_payload FROM audit_events WHERE event_type = 'encryption-rotated'",
					)
					.toArray(),
			),
		).toEqual([{ event_type: "encryption-rotated", public_payload: "{}" }]);
	});

	it("creates, validates, expires, revokes, and epoch-invalidates approver sessions", async () => {
		const stub = approver();
		const now = 1_800_000_000_000;
		await expect(
			stub.createApproverSession({
				approverDid: APPROVER_DID,
				tokenHash: TOKEN_HASH,
				csrfHash: CSRF_HASH,
				expiresAt: now + 60_000,
				now,
			}),
		).resolves.toMatchObject({
			ok: true,
			session: { approverDid: APPROVER_DID, sessionEpoch: 1 },
		});
		await expect(
			stub.validateApproverSession(APPROVER_DID, TOKEN_HASH, CSRF_HASH, now + 1),
		).resolves.toMatchObject({ ok: true });
		await expect(
			stub.validateApproverSession(APPROVER_DID, TOKEN_HASH, STATE_HASH, now + 1),
		).resolves.toEqual({ ok: false, code: "APPROVER_SESSION_INVALID" });

		await expect(stub.revokeAllApproverSessions(APPROVER_DID, now + 2)).resolves.toBe(2);
		await expect(
			stub.validateApproverSession(APPROVER_DID, TOKEN_HASH, null, now + 3),
		).resolves.toEqual({ ok: false, code: "APPROVER_SESSION_INVALID" });

		const secondToken = `${TOKEN_HASH.slice(0, -1)}h`;
		await stub.createApproverSession({
			approverDid: APPROVER_DID,
			tokenHash: secondToken,
			csrfHash: CSRF_HASH,
			expiresAt: now + 10,
			now: now + 3,
		});
		await expect(
			stub.validateApproverSession(APPROVER_DID, secondToken, null, now + 11),
		).resolves.toEqual({ ok: false, code: "APPROVER_SESSION_EXPIRED" });
		await expect(stub.revokeApproverSession(APPROVER_DID, secondToken, now + 12)).resolves.toBe(
			false,
		);
	});

	it("manages multiple safe credential views and rejects counter regression", async () => {
		const stub = approver();
		const now = 1_800_000_000_000;
		await expect(stub.enrolCredential(APPROVER_DID, credentialInput())).resolves.toMatchObject({
			ok: true,
			credential: { id: CREDENTIAL_ID, name: "Laptop", transports: ["internal"] },
		});
		await stub.enrolCredential(APPROVER_DID, credentialInput(SECOND_CREDENTIAL_ID, now + 1));

		const listed = await stub.listCredentials(APPROVER_DID, null, 10);
		expect(listed).toHaveLength(2);
		expect(JSON.stringify(listed)).not.toContain("publicKey");
		await expect(
			stub.getCredentialForVerification(APPROVER_DID, CREDENTIAL_ID),
		).resolves.toMatchObject({
			id: CREDENTIAL_ID,
			algorithm: -7,
			counter: 0,
			publicKey: new Uint8Array([1, 2, 3, 4]),
		});

		await expect(
			stub.commitCredentialUse(APPROVER_DID, CREDENTIAL_ID, 0, 0, now + 2),
		).resolves.toEqual({ ok: true, counter: 0 });
		await expect(
			stub.commitCredentialUse(APPROVER_DID, CREDENTIAL_ID, 0, 1, now + 3),
		).resolves.toEqual({ ok: true, counter: 1 });
		await expect(
			stub.commitCredentialUse(APPROVER_DID, CREDENTIAL_ID, 1, 0, now + 4),
		).resolves.toEqual({ ok: false, code: "COUNTER_REGRESSION" });
		await expect(
			runInDurableObject(stub, (_instance, state) =>
				state.storage.sql
					.exec<{ event_type: string; reason_code: string | null }>(
						`SELECT event_type, reason_code FROM audit_events
						 WHERE event_type = 'credential-counter-regression'`,
					)
					.one(),
			),
		).resolves.toEqual({
			event_type: "credential-counter-regression",
			reason_code: "COUNTER_REGRESSION",
		});
		await expect(
			stub.commitCredentialUse(APPROVER_DID, CREDENTIAL_ID, 0, 2, now + 4),
		).resolves.toEqual({ ok: false, code: "CREDENTIAL_STATE_CHANGED" });
	});

	it("reports enrolment and revocation state without initializing an empty shard", async () => {
		const empty = env.APPROVER_DO.getByName(OTHER_APPROVER_DID);
		await expect(empty.getEnrollmentStatus(OTHER_APPROVER_DID)).resolves.toEqual({
			credentialCount: 0,
			activeCredentialCount: 0,
			firstEnrolledAt: null,
			lastEnrolledAt: null,
			lastRevokedAt: null,
		});
		await expect(
			runInDurableObject(empty, (_instance, state) =>
				state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM approver").one(),
			),
		).resolves.toEqual({ count: 0 });

		const stub = approver();
		const now = 1_800_000_000_000;
		await stub.enrolCredential(APPROVER_DID, credentialInput(CREDENTIAL_ID, now));
		await stub.enrolCredential(APPROVER_DID, credentialInput(SECOND_CREDENTIAL_ID, now + 1));
		await stub.revokeCredential(APPROVER_DID, CREDENTIAL_ID, now + 2);

		await expect(stub.getEnrollmentStatus(APPROVER_DID)).resolves.toEqual({
			credentialCount: 2,
			activeCredentialCount: 1,
			firstEnrolledAt: now,
			lastEnrolledAt: now + 1,
			lastRevokedAt: now + 2,
		});
	});

	it("binds approval challenges to intent inputs and consumes them once", async () => {
		const stub = approver();
		const now = 1_800_000_000_000;
		await expect(
			stub.createChallenge(APPROVER_DID, {
				challengeHash: CHALLENGE_HASH,
				kind: "approval",
				intentId: INTENT_ID,
				publisherDid: PUBLISHER_DID,
				approvalDigest: APPROVAL_DIGEST,
				context: "canonical-approval-context",
				expiresAt: now + 60_000,
				now,
			}),
		).resolves.toEqual({ ok: true });

		await expect(
			stub.consumeChallenge(APPROVER_DID, CHALLENGE_HASH, "registration", now + 1),
		).resolves.toEqual({ ok: false, code: "CHALLENGE_NOT_FOUND" });
		await expect(
			stub.consumeChallenge(APPROVER_DID, CHALLENGE_HASH, "approval", now + 2),
		).resolves.toEqual({
			ok: true,
			challenge: {
				kind: "approval",
				intentId: INTENT_ID,
				publisherDid: PUBLISHER_DID,
				approvalDigest: APPROVAL_DIGEST,
				context: "canonical-approval-context",
				expiresAt: now + 60_000,
			},
		});
		await expect(
			stub.consumeChallenge(APPROVER_DID, CHALLENGE_HASH, "approval", now + 3),
		).resolves.toEqual({ ok: false, code: "CHALLENGE_CONSUMED" });
	});

	it("accepts challenge expiry within the worker-to-DO clock-skew allowance", async () => {
		const now = 1_800_000_000_000;
		await expect(
			approver().createChallenge(APPROVER_DID, {
				challengeHash: CHALLENGE_HASH,
				kind: "registration",
				context: "registration-context",
				expiresAt: now + 5 * 60_000 + 1_000,
				now,
			}),
		).resolves.toEqual({ ok: true });
	});

	it("bounds retained challenge tombstones while issuing new challenges", async () => {
		const stub = approver();
		const now = 1_800_000_000_000;
		for (let index = 0; index < 75; index += 1) {
			const challengeHash = String(index).padStart(43, "a");
			await stub.createChallenge(APPROVER_DID, {
				challengeHash,
				kind: "registration",
				context: "registration-context",
				expiresAt: now + 60_000,
				now,
			});
			await stub.consumeChallenge(APPROVER_DID, challengeHash, "registration", now + 1);
		}

		await expect(
			runInDurableObject(stub, (_instance, state) =>
				state.storage.sql
					.exec<{ count: number }>("SELECT COUNT(*) AS count FROM approval_challenges")
					.one(),
			),
		).resolves.toEqual({ count: 1 });
	});

	it("invalidates outstanding intent challenges on credential revocation", async () => {
		const stub = approver();
		const now = 1_800_000_000_000;
		await stub.enrolCredential(APPROVER_DID, credentialInput());
		await stub.createChallenge(APPROVER_DID, {
			challengeHash: CHALLENGE_HASH,
			kind: "approval",
			intentId: INTENT_ID,
			publisherDid: PUBLISHER_DID,
			approvalDigest: APPROVAL_DIGEST,
			context: "approval-context",
			expiresAt: now + 60_000,
			now,
		});

		await expect(
			stub.revokeCredential(APPROVER_DID, CREDENTIAL_ID, now + 1),
		).resolves.toMatchObject({ ok: true, credential: { revokedAt: now + 1 } });
		await expect(
			stub.consumeChallenge(APPROVER_DID, CHALLENGE_HASH, "approval", now + 2),
		).resolves.toEqual({ ok: false, code: "CHALLENGE_CONSUMED" });
		await expect(
			stub.getCredentialForVerification(APPROVER_DID, CREDENTIAL_ID),
		).resolves.toBeNull();
	});

	it("records one idempotent decision receipt and rejects conflicting replay", async () => {
		const stub = approver();
		const now = 1_800_000_000_000;
		await stub.enrolCredential(APPROVER_DID, credentialInput());
		await stub.createChallenge(APPROVER_DID, {
			challengeHash: CHALLENGE_HASH,
			kind: "approval",
			intentId: INTENT_ID,
			publisherDid: PUBLISHER_DID,
			approvalDigest: APPROVAL_DIGEST,
			context: "approval-context",
			expiresAt: now + 60_000,
			now,
		});
		const input = {
			idempotencyKey: "decision-idempotency-0001",
			intentId: INTENT_ID,
			publisherDid: PUBLISHER_DID,
			approvalDigest: APPROVAL_DIGEST,
			decision: "approve" as const,
			credentialId: CREDENTIAL_ID,
			verifiedAt: now + 1,
			expectedCounter: 0,
			newCounter: 1,
		};

		const recorded = await stub.commitVerifiedDecision(APPROVER_DID, input);
		expect(recorded).toEqual({
			ok: true,
			replayed: false,
			receipt: {
				approverDid: APPROVER_DID,
				publisherDid: PUBLISHER_DID,
				intentId: INTENT_ID,
				approvalDigest: APPROVAL_DIGEST,
				decision: "approve",
				credentialId: CREDENTIAL_ID,
				verifiedAt: now + 1,
			},
		});
		await expect(
			stub.commitVerifiedDecision(APPROVER_DID, { ...input, verifiedAt: now + 10 }),
		).resolves.toMatchObject({
			ok: true,
			replayed: true,
			receipt: { verifiedAt: now + 1 },
		});
		await expect(
			stub.commitVerifiedDecision(APPROVER_DID, { ...input, decision: "reject" }),
		).resolves.toEqual({ ok: false, code: "DECISION_IDEMPOTENCY_CONFLICT" });
		await expect(
			stub.commitVerifiedDecision(APPROVER_DID, {
				...input,
				idempotencyKey: "decision-idempotency-0002",
				decision: "reject",
			}),
		).resolves.toEqual({ ok: false, code: "DECISION_CONFLICT" });
		await expect(
			stub.consumeChallenge(APPROVER_DID, CHALLENGE_HASH, "approval", now + 2),
		).resolves.toEqual({ ok: false, code: "CHALLENGE_CONSUMED" });
	});

	it("cleans bounded expired state and maintains the earliest alarm", async () => {
		const stub = approver();
		const now = 1_800_000_000_000;
		await stub.createApproverSession({
			approverDid: APPROVER_DID,
			tokenHash: TOKEN_HASH,
			csrfHash: CSRF_HASH,
			expiresAt: now + 30,
			now,
		});
		await stub.putIdentityTransaction({
			approverDid: APPROVER_DID,
			stateHash: STATE_HASH,
			encryptedState: "encrypted",
			encryptionKeyVersion: 1,
			clientKeyId: "assertion-1",
			redirectTarget: "/approver",
			expiresAt: now + 20,
			now,
		});
		await stub.createChallenge(APPROVER_DID, {
			challengeHash: SECOND_CHALLENGE_HASH,
			kind: "registration",
			context: "registration-context",
			expiresAt: now + 10,
			now,
		});

		await expect(
			runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
		).resolves.toBe(now + 10);
		await expect(stub.cleanupExpired(APPROVER_DID, now + 31)).resolves.toEqual({
			challenges: 1,
			identities: 1,
			sessions: 1,
		});
		await expect(
			runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
		).resolves.toBeNull();
	});
});

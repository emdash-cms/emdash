import {
	abortAllDurableObjects,
	reset,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

const DID = "did:plc:publisher";
const OTHER_DID = "did:plc:other";
const STATE_HASH = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const SESSION_TOKEN_HASH = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefg";
const SESSION_CSRF_HASH = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg";
const DELEGATION_METADATA = {
	encryptionKeyVersion: 2,
	issuer: "https://authorization.example",
	pdsUrl: "https://pds.example",
	expiresAt: null,
} as const;

function publisher() {
	return env.PUBLISHER_DO.getByName(DID);
}

afterEach(async () => {
	await reset();
});

describe("PublisherDurableObject", () => {
	it("creates, validates, expires, and revokes hashed publisher sessions", async () => {
		const stub = publisher();
		const now = 1_800_000_000_000;
		await expect(
			stub.createPublisherSession({
				publisherDid: DID,
				tokenHash: SESSION_TOKEN_HASH,
				csrfHash: SESSION_CSRF_HASH,
				expiresAt: now + 60_000,
				now,
			}),
		).resolves.toMatchObject({
			ok: true,
			session: { publisherDid: DID, expiresAt: now + 60_000, sessionEpoch: 1 },
		});
		await expect(
			stub.createPublisherSession({
				publisherDid: DID,
				tokenHash: SESSION_TOKEN_HASH,
				csrfHash: SESSION_CSRF_HASH,
				expiresAt: now + 60_000,
				now,
			}),
		).resolves.toEqual({ ok: false, code: "PUBLISHER_SESSION_EXISTS" });
		await expect(
			stub.validatePublisherSession(DID, SESSION_TOKEN_HASH, null, now + 1),
		).resolves.toMatchObject({ ok: true, session: { publisherDid: DID } });
		await expect(
			stub.validatePublisherSession(DID, SESSION_TOKEN_HASH, SESSION_CSRF_HASH, now + 1),
		).resolves.toMatchObject({ ok: true });
		await expect(
			stub.validatePublisherSession(DID, SESSION_TOKEN_HASH, STATE_HASH, now + 1),
		).resolves.toEqual({ ok: false, code: "PUBLISHER_SESSION_INVALID" });
		await expect(
			stub.validatePublisherSession(DID, SESSION_TOKEN_HASH, null, now + 60_001),
		).resolves.toEqual({ ok: false, code: "PUBLISHER_SESSION_EXPIRED" });
		await expect(
			stub.validatePublisherSession(DID, SESSION_TOKEN_HASH, null, now + 60_002),
		).resolves.toEqual({ ok: false, code: "PUBLISHER_SESSION_INVALID" });

		const secondHash = `${SESSION_TOKEN_HASH.slice(0, -1)}h`;
		await stub.createPublisherSession({
			publisherDid: DID,
			tokenHash: secondHash,
			csrfHash: SESSION_CSRF_HASH,
			expiresAt: now + 120_000,
			now,
		});
		await expect(stub.revokePublisherSession(DID, secondHash)).resolves.toBe(true);
		await expect(stub.revokePublisherSession(DID, secondHash)).resolves.toBe(false);
	});

	it("limits active publisher sessions per shard", async () => {
		const stub = publisher();
		const now = 1_800_000_000_000;
		for (let index = 0; index < 20; index += 1) {
			await expect(
				stub.createPublisherSession({
					publisherDid: DID,
					tokenHash: String(index).padStart(43, "A"),
					csrfHash: SESSION_CSRF_HASH,
					expiresAt: now + 60_000,
					now,
				}),
			).resolves.toMatchObject({ ok: true });
		}
		await expect(
			stub.createPublisherSession({
				publisherDid: DID,
				tokenHash: "Z".repeat(43),
				csrfHash: SESSION_CSRF_HASH,
				expiresAt: now + 60_000,
				now,
			}),
		).resolves.toEqual({ ok: false, code: "PUBLISHER_SESSION_LIMIT_REACHED" });
	});

	it("invalidates all publisher sessions by epoch and blocks suspended publishers", async () => {
		const stub = publisher();
		const now = 1_800_000_000_000;
		await stub.createPublisherSession({
			publisherDid: DID,
			tokenHash: SESSION_TOKEN_HASH,
			csrfHash: SESSION_CSRF_HASH,
			expiresAt: now + 60_000,
			now,
		});
		await expect(stub.revokeAllPublisherSessions(DID)).resolves.toBe(2);
		await expect(
			stub.validatePublisherSession(DID, SESSION_TOKEN_HASH, null, now + 1),
		).resolves.toEqual({ ok: false, code: "PUBLISHER_SESSION_INVALID" });

		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec("UPDATE publisher SET status = 'suspended' WHERE id = 1");
		});
		await expect(
			stub.createPublisherSession({
				publisherDid: DID,
				tokenHash: SESSION_TOKEN_HASH,
				csrfHash: SESSION_CSRF_HASH,
				expiresAt: now + 60_000,
				now,
			}),
		).resolves.toEqual({ ok: false, code: "PUBLISHER_SUSPENDED" });
	});

	it("schedules one alarm for publisher state expiry and expires pending intents", async () => {
		const stub = publisher();
		const now = Date.now();
		await stub.putWorkloadPolicy({
			publisherDid: DID,
			packageSlug: "gallery",
			repository: "example/gallery",
			repositoryId: "123",
			repositoryOwnerId: "456",
			workflowRef: "example/gallery/.github/workflows/release.yml@refs/heads/main",
			allowedRefs: [],
			allowedEnvironments: [],
			active: true,
			expectedVersion: null,
			now,
		});
		await stub.createPublisherSession({
			publisherDid: DID,
			tokenHash: SESSION_TOKEN_HASH,
			csrfHash: SESSION_CSRF_HASH,
			expiresAt: now + 40_000,
			now,
		});
		await stub.putOAuthState({
			publisherDid: DID,
			stateHash: STATE_HASH,
			encryptedState: "encrypted-oauth-state",
			encryptionKeyVersion: 2,
			encryptionPurpose: "oauth-console-transaction",
			clientKeyId: "assertion-1",
			redirectTarget: "/publisher",
			expiresAt: now + 30_000,
			now,
		});
		await stub.createIntent({
			publisherDid: DID,
			intentId: "01JABCDEFGHJKMNPQRSTVWXYZ0",
			packageSlug: "gallery",
			version: "1.2.3",
			workloadPolicyVersion: 1,
			workloadIdentityDigest: "A".repeat(43),
			workloadIdempotencyDigest: "I".repeat(43),
			idempotencyKey: "publisher-alarm-intent-0001",
			requestDigest: "B".repeat(43),
			workloadIdentityJson: '{"issuer":"github-actions"}',
			releaseInputJson: '{"release":{"package":"gallery","version":"1.2.3"}}',
			expiresAt: now + 20_000,
			now,
		});

		await expect(
			runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
		).resolves.toBe(now + 20_000);
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec("UPDATE intents SET expires_at = ?", now - 1);
			state.storage.sql.exec("UPDATE oauth_states SET expires_at = ?", now - 1);
			state.storage.sql.exec("UPDATE publisher_sessions SET expires_at = ?", now - 1);
		});
		await runDurableObjectAlarm(stub);

		await expect(stub.getIntent(DID, "01JABCDEFGHJKMNPQRSTVWXYZ0")).resolves.toMatchObject({
			state: "expired",
		});
		await expect(stub.consumeOAuthState(DID, STATE_HASH, now)).resolves.toBeNull();
		await expect(
			stub.validatePublisherSession(DID, SESSION_TOKEN_HASH, null, now),
		).resolves.toEqual({ ok: false, code: "PUBLISHER_SESSION_INVALID" });
	});

	it("isolates publisher, repository, and workload admission budgets", async () => {
		const stub = publisher();
		const now = 1_800_000_000_000;
		const workloadKey = "W".repeat(43);
		for (let index = 0; index < 30; index += 1) {
			await expect(
				stub.consumeIntentRateLimit({
					publisherDid: DID,
					repositoryId: "123",
					workloadKey,
					idempotencyKey: `rate-workload-a-${String(index).padStart(4, "0")}`,
					expiresAt: now + 24 * 60 * 60_000,
					now,
				}),
			).resolves.toMatchObject({ ok: true, replayed: false });
		}
		await expect(
			stub.consumeIntentRateLimit({
				publisherDid: DID,
				repositoryId: "123",
				workloadKey,
				idempotencyKey: "rate-workload-a-over-limit",
				expiresAt: now + 24 * 60 * 60_000,
				now,
			}),
		).resolves.toMatchObject({ ok: false, code: "RATE_LIMITED", scope: "workload" });
		await expect(
			stub.consumeIntentRateLimit({
				publisherDid: DID,
				repositoryId: "123",
				workloadKey,
				idempotencyKey: "rate-workload-a-0000",
				expiresAt: now + 24 * 60 * 60_000,
				now,
			}),
		).resolves.toMatchObject({ ok: true, replayed: true });
		await expect(
			stub.consumeIntentRateLimit({
				publisherDid: DID,
				repositoryId: "123",
				workloadKey: "X".repeat(43),
				idempotencyKey: "rate-workload-b-0000",
				expiresAt: now + 24 * 60 * 60_000,
				now,
			}),
		).resolves.toMatchObject({ ok: true });
		for (let index = 1; index <= 29; index += 1) {
			await stub.consumeIntentRateLimit({
				publisherDid: DID,
				repositoryId: "123",
				workloadKey: `Y${String(index).padStart(42, "0")}`,
				idempotencyKey: `rate-repository-${String(index).padStart(4, "0")}`,
				expiresAt: now + 24 * 60 * 60_000,
				now,
			});
		}
		await expect(
			stub.consumeIntentRateLimit({
				publisherDid: DID,
				repositoryId: "123",
				workloadKey: "Q".repeat(43),
				idempotencyKey: "rate-repository-over-limit",
				expiresAt: now + 24 * 60 * 60_000,
				now,
			}),
		).resolves.toMatchObject({ ok: false, code: "RATE_LIMITED", scope: "repository" });
		for (let index = 0; index < 60; index += 1) {
			await stub.consumeIntentRateLimit({
				publisherDid: DID,
				repositoryId: "456",
				workloadKey: `P${String(index).padStart(42, "0")}`,
				idempotencyKey: `rate-publisher-${String(index).padStart(4, "0")}`,
				expiresAt: now + 24 * 60 * 60_000,
				now,
			});
		}
		await expect(
			stub.consumeIntentRateLimit({
				publisherDid: DID,
				repositoryId: "789",
				workloadKey: "V".repeat(43),
				idempotencyKey: "rate-publisher-over-limit",
				expiresAt: now + 24 * 60 * 60_000,
				now,
			}),
		).resolves.toMatchObject({ ok: false, code: "RATE_LIMITED", scope: "publisher" });
		await expect(
			env.PUBLISHER_DO.getByName(OTHER_DID).consumeIntentRateLimit({
				publisherDid: OTHER_DID,
				repositoryId: "123",
				workloadKey,
				idempotencyKey: "rate-other-publisher-0000",
				expiresAt: now + 24 * 60 * 60_000,
				now,
			}),
		).resolves.toMatchObject({ ok: true });
		await expect(
			stub.consumeIntentRateLimit({
				publisherDid: DID,
				repositoryId: "123",
				workloadKey,
				idempotencyKey: "rate-next-window-0000",
				expiresAt: now + 24 * 60 * 60_000,
				now: now + 60_000,
			}),
		).resolves.toMatchObject({ ok: true, replayed: false });
	});

	it("arms cleanup for rate-limit idempotency without another publisher operation", async () => {
		const stub = publisher();
		const now = 1_800_000_000_000;
		const expiresAt = now + 24 * 60 * 60_000;
		await expect(
			stub.consumeIntentRateLimit({
				publisherDid: DID,
				repositoryId: "123",
				workloadKey: "W".repeat(43),
				idempotencyKey: "rate-alarm-idempotency-0001",
				expiresAt,
				now,
			}),
		).resolves.toMatchObject({ ok: true, replayed: false });

		await expect(
			runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
		).resolves.toBe(expiresAt);
	});

	it("routes and binds one object to one publisher DID", async () => {
		const stub = publisher();
		await stub.initializePublisher(DID);
		await runInDurableObject(stub, async (instance) => {
			expect(() => instance.initializePublisher(OTHER_DID)).toThrowError(
				expect.objectContaining({ code: "PUBLISHER_DID_MISMATCH" }),
			);
		});

		const unnamedStub = env.PUBLISHER_DO.get(env.PUBLISHER_DO.newUniqueId());
		await runInDurableObject(unnamedStub, async (instance) => {
			expect(() => instance.initializePublisher(DID)).toThrowError(
				expect.objectContaining({ code: "PUBLISHER_DID_MISMATCH" }),
			);
		});

		const invalidMethodDid = "did:0method:publisher";
		const invalidMethodStub = env.PUBLISHER_DO.getByName(invalidMethodDid);
		await runInDurableObject(invalidMethodStub, async (instance) => {
			expect(() => instance.initializePublisher(invalidMethodDid)).toThrowError(
				expect.objectContaining({ code: "PUBLISHER_DID_INVALID" }),
			);
		});
	});

	it("stores encrypted OAuth state without plaintext and consumes it once", async () => {
		const stub = publisher();
		const expiresAt = Date.now() + 60_000;
		await expect(
			stub.putOAuthState({
				publisherDid: DID,
				stateHash: STATE_HASH,
				encryptedState: "encrypted-oauth-state",
				encryptionKeyVersion: 2,
				encryptionPurpose: "oauth-console-transaction",
				clientKeyId: "assertion-1",
				redirectTarget: "/publisher/delegation",
				expiresAt,
			}),
		).resolves.toEqual({ ok: true });
		await expect(
			runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
		).resolves.toBe(expiresAt);

		const storedRows = await runInDurableObject(stub, (_instance, state) =>
			state.storage.sql
				.exec<{ state_hash: string; encrypted_state: string }>(
					"SELECT state_hash, encrypted_state FROM oauth_states",
				)
				.toArray(),
		);
		expect(storedRows).toEqual([
			{ state_hash: STATE_HASH, encrypted_state: "encrypted-oauth-state" },
		]);

		await expect(stub.consumeOAuthState(DID, STATE_HASH)).resolves.toMatchObject({
			encryptedState: "encrypted-oauth-state",
			clientKeyId: "assertion-1",
		});
		await expect(stub.consumeOAuthState(DID, STATE_HASH)).resolves.toBeNull();

		const auditRows = await runInDurableObject(stub, (_instance, state) =>
			state.storage.sql
				.exec<{
					event_type: string;
					actor_realm: string;
					actor_identity: string;
					public_payload: string;
				}>(
					`SELECT event_type, actor_realm, actor_identity, public_payload
					 FROM audit_events ORDER BY sequence`,
				)
				.toArray(),
		);
		expect(auditRows).toEqual([
			{
				event_type: "oauth-state-created",
				actor_realm: "publisher",
				actor_identity: DID,
				public_payload: "{}",
			},
			{
				event_type: "oauth-state-consumed",
				actor_realm: "publisher",
				actor_identity: DID,
				public_payload: "{}",
			},
		]);
		expect(JSON.stringify(auditRows)).not.toContain("encrypted-oauth-state");
	});

	it.each(["https://attacker.example/callback", "//attacker.example/callback", "callback"])(
		"rejects unsafe OAuth redirect target %s",
		async (redirectTarget) => {
			await runInDurableObject(publisher(), async (instance) => {
				await expect(
					instance.putOAuthState({
						publisherDid: DID,
						stateHash: STATE_HASH,
						encryptedState: "encrypted-oauth-state",
						encryptionKeyVersion: 2,
						encryptionPurpose: "oauth-console-transaction",
						clientKeyId: "assertion-1",
						redirectTarget,
						expiresAt: Date.now() + 60_000,
					}),
				).rejects.toMatchObject({ code: "OAUTH_STATE_INVALID" });
			});
		},
	);
	it("limits active publisher OAuth states per shard", async () => {
		const stub = publisher();
		const now = 1_800_000_000_000;
		for (let index = 0; index < 20; index += 1) {
			await expect(
				stub.putOAuthState({
					publisherDid: DID,
					stateHash: String(index).padStart(43, "a"),
					encryptedState: "encrypted-oauth-state",
					encryptionKeyVersion: 2,
					encryptionPurpose: "oauth-console-transaction",
					clientKeyId: "assertion-1",
					redirectTarget: "/publisher",
					expiresAt: now + 60_000,
					now,
				}),
			).resolves.toEqual({ ok: true });
		}
		await expect(
			stub.putOAuthState({
				publisherDid: DID,
				stateHash: "Z".repeat(43),
				encryptedState: "encrypted-oauth-state",
				encryptionKeyVersion: 2,
				encryptionPurpose: "oauth-console-transaction",
				clientKeyId: "assertion-1",
				redirectTarget: "/publisher",
				expiresAt: now + 60_000,
				now,
			}),
		).resolves.toEqual({ ok: false, code: "OAUTH_STATE_LIMIT_REACHED" });
	});

	it("rejects duplicate state and deletes expired state on consume", async () => {
		const stub = publisher();
		const stateHash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
		const expiresAt = Date.now() + 60_000;
		const input = {
			publisherDid: DID,
			stateHash,
			encryptedState: "encrypted",
			encryptionKeyVersion: 2,
			encryptionPurpose: "oauth-delegation-transaction" as const,
			clientKeyId: "assertion-1",
			redirectTarget: "/callback",
			expiresAt,
		};
		await expect(stub.putOAuthState(input)).resolves.toEqual({ ok: true });
		await expect(stub.putOAuthState(input)).resolves.toEqual({
			ok: false,
			code: "OAUTH_STATE_EXISTS",
		});
		await expect(stub.consumeOAuthState(DID, stateHash, expiresAt + 1)).resolves.toBeNull();
		const expiredAudit = await runInDurableObject(stub, (_instance, state) =>
			state.storage.sql
				.exec<{ event_type: string; actor_realm: string; reason_code: string | null }>(
					`SELECT event_type, actor_realm, reason_code FROM audit_events
					 WHERE event_type = 'oauth-state-expired'`,
				)
				.one(),
		);
		expect(expiredAudit).toEqual({
			event_type: "oauth-state-expired",
			actor_realm: "system",
			reason_code: "OAUTH_STATE_EXPIRED",
		});
	});

	it("pages live ciphertexts and replaces them only by compare-and-set", async () => {
		const stub = publisher();
		const now = Date.now();
		await stub.putOAuthState({
			publisherDid: DID,
			stateHash: STATE_HASH,
			encryptedState: "oauth-ciphertext-v2",
			encryptionKeyVersion: 2,
			encryptionPurpose: "oauth-console-transaction",
			clientKeyId: "assertion-1",
			redirectTarget: "/publisher",
			expiresAt: now + 60_000,
		});
		await stub.putDelegation({
			publisherDid: DID,
			releaseNsid: "com.emdashcms.experimental.package.release",
			scope:
				"atproto repo:com.emdashcms.experimental.package.release?action=create blob:application/gzip blob:image/*",
			clientKeyId: "assertion-1",
			encryptedSession: "delegation-ciphertext-v2",
			...DELEGATION_METADATA,
			refreshBefore: now + 60_000,
			expectedVersion: null,
		});

		const first = await stub.listEncryptionRecords(DID, null, 1, now);
		expect(first).toMatchObject({
			items: [
				{
					cursor: "delegation:1",
					envelope: "delegation-ciphertext-v2",
					keyVersion: 2,
					context: { purpose: "oauth-session", ownerDid: DID },
				},
			],
			nextCursor: "delegation:1",
		});
		const second = await stub.listEncryptionRecords(DID, first.nextCursor, 1, now);
		expect(second).toMatchObject({
			items: [
				{
					cursor: `oauth-state:${STATE_HASH}`,
					envelope: "oauth-ciphertext-v2",
					context: { purpose: "oauth-console-transaction", ownerDid: DID },
				},
			],
			nextCursor: null,
		});

		await expect(
			stub.replaceEncryptionRecord({
				publisherDid: DID,
				cursor: `oauth-state:${STATE_HASH}`,
				expectedEnvelope: "wrong-ciphertext",
				replacementEnvelope: "oauth-ciphertext-v3",
				replacementKeyVersion: 3,
				actorIdentity: "operator@example.com",
				now,
			}),
		).resolves.toBe(false);
		await expect(
			stub.replaceEncryptionRecord({
				publisherDid: DID,
				cursor: `oauth-state:${STATE_HASH}`,
				expectedEnvelope: "oauth-ciphertext-v2",
				replacementEnvelope: "oauth-ciphertext-v3",
				replacementKeyVersion: 3,
				actorIdentity: "operator@example.com",
				now,
			}),
		).resolves.toBe(true);
		await runInDurableObject(stub, (instance) => {
			expect(() => instance.listEncryptionRecords(DID, "not-a-cursor", 10, now)).toThrowError(
				expect.objectContaining({ code: "ENCRYPTION_OPERATION_INVALID" }),
			);
		});

		const records = await stub.listEncryptionRecords(DID, null, 10, now);
		expect(records.items[1]).toMatchObject({ envelope: "oauth-ciphertext-v3", keyVersion: 3 });
		const audit = await runInDurableObject(stub, (_instance, state) =>
			state.storage.sql
				.exec<{ event_type: string; public_payload: string }>(
					"SELECT event_type, public_payload FROM audit_events WHERE event_type = 'encryption-rotated'",
				)
				.toArray(),
		);
		expect(audit).toEqual([{ event_type: "encryption-rotated", public_payload: "{}" }]);
		expect(JSON.stringify(audit)).not.toContain("ciphertext");
	});

	it("applies compare-and-set delegation updates and revocation", async () => {
		const stub = publisher();
		const firstResult = await stub.putDelegation({
			publisherDid: DID,
			releaseNsid: "com.emdashcms.experimental.package.release",
			scope:
				"atproto repo:com.emdashcms.experimental.package.release?action=create blob:application/gzip blob:image/*",
			clientKeyId: "assertion-1",
			encryptedSession: "ciphertext-v1",
			...DELEGATION_METADATA,
			refreshBefore: Date.now() + 60_000,
			expectedVersion: null,
		});
		expect(firstResult.ok).toBe(true);
		if (!firstResult.ok) return;
		const first = firstResult.delegation;
		expect(first).toMatchObject({ status: "active", stateVersion: 1 });

		await expect(
			stub.putDelegation({
				publisherDid: DID,
				releaseNsid: first.releaseNsid,
				scope: first.scope,
				clientKeyId: "assertion-2",
				encryptedSession: "ciphertext-v2",
				...DELEGATION_METADATA,
				refreshBefore: null,
				expectedVersion: null,
			}),
		).resolves.toEqual({ ok: false, code: "DELEGATION_CAS_REQUIRED" });

		const secondResult = await stub.putDelegation({
			publisherDid: DID,
			releaseNsid: first.releaseNsid,
			scope: first.scope,
			clientKeyId: "assertion-2",
			encryptedSession: "ciphertext-v2",
			...DELEGATION_METADATA,
			refreshBefore: null,
			expectedVersion: 1,
		});
		expect(secondResult.ok).toBe(true);
		if (!secondResult.ok) return;
		const second = secondResult.delegation;
		expect(second).toMatchObject({ status: "active", stateVersion: 2 });

		await expect(stub.revokeDelegation(DID, 1)).resolves.toEqual({
			ok: false,
			code: "DELEGATION_CAS_REQUIRED",
		});
		const revoked = await stub.revokeDelegation(DID, 2);
		expect(revoked.ok).toBe(true);
		if (revoked.ok) {
			expect(revoked.delegation).toMatchObject({ status: "revoked", stateVersion: 3 });
		}
	});

	it("serializes refresh with generation-bound leases and compare-and-set completion", async () => {
		const stub = publisher();
		const now = 1_800_000_000_000;
		await expect(
			stub.putDelegation({
				publisherDid: DID,
				releaseNsid: "com.emdashcms.experimental.package.release",
				scope:
					"atproto repo:com.emdashcms.experimental.package.release?action=create blob:application/gzip blob:image/*",
				clientKeyId: "assertion-1",
				encryptedSession: "ciphertext-v1",
				...DELEGATION_METADATA,
				refreshBefore: now + 30_000,
				expectedVersion: null,
			}),
		).resolves.toMatchObject({ ok: true });

		const first = await stub.beginDelegationRefresh(DID, 60_000, now);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.lease).toMatchObject({
			generation: 1,
			expectedVersion: 1,
			expiresAt: now + 60_000,
		});
		const busy = await stub.beginDelegationRefresh(DID, 60_000, now + 1);
		expect(busy).toEqual({
			ok: false,
			code: "DELEGATION_REFRESH_BUSY",
			retryAt: now + 60_000,
		});
		await expect(
			stub.getDelegationForRefresh(DID, first.lease.generation, `${"A".repeat(42)}B`, now + 1),
		).resolves.toBeNull();
		await expect(
			stub.getDelegationForRefresh(DID, first.lease.generation, first.lease.token, now + 1),
		).resolves.toMatchObject({ encryptedSession: "ciphertext-v1", stateVersion: 1 });

		await expect(
			stub.completeDelegationRefresh({
				publisherDid: DID,
				generation: first.lease.generation,
				token: first.lease.token,
				expectedVersion: 2,
				clientKeyId: "assertion-2",
				encryptedSession: "ciphertext-v2",
				...DELEGATION_METADATA,
				refreshBefore: now + 90_000,
				now: now + 2,
			}),
		).resolves.toEqual({ ok: false, code: "DELEGATION_CAS_REQUIRED" });

		const completed = await stub.completeDelegationRefresh({
			publisherDid: DID,
			generation: first.lease.generation,
			token: first.lease.token,
			expectedVersion: first.lease.expectedVersion,
			clientKeyId: "assertion-2",
			encryptedSession: "ciphertext-v2",
			...DELEGATION_METADATA,
			refreshBefore: now + 90_000,
			now: now + 2,
		});
		expect(completed).toMatchObject({
			ok: true,
			delegation: { encryptedSession: "ciphertext-v2", stateVersion: 2 },
		});
		await expect(
			stub.getDelegationForRefresh(DID, first.lease.generation, first.lease.token, now + 3),
		).resolves.toBeNull();

		const persisted = await runInDurableObject(stub, (_instance, state) => ({
			operation: state.storage.sql
				.exec<{ token_hash: string | null }>(
					"SELECT token_hash FROM delegation_operations WHERE kind = 'refresh'",
				)
				.one(),
			audit: state.storage.sql
				.exec<{ event_type: string; subject: string }>(
					"SELECT event_type, subject FROM audit_events ORDER BY sequence",
				)
				.toArray(),
		}));
		expect(persisted.operation.token_hash).toBeNull();
		expect(JSON.stringify(persisted)).not.toContain(first.lease.token);
		expect(persisted.audit.map((event) => event.event_type)).toEqual(
			expect.arrayContaining(["delegation-refresh-started", "delegation-refresh-completed"]),
		);
	});

	it("supersedes expired refresh leases and wipes retained authority on revocation", async () => {
		const stub = publisher();
		const now = 1_800_000_000_000;
		await stub.putDelegation({
			publisherDid: DID,
			releaseNsid: "com.emdashcms.experimental.package.release",
			scope:
				"atproto repo:com.emdashcms.experimental.package.release?action=create blob:application/gzip blob:image/*",
			clientKeyId: "assertion-1",
			encryptedSession: "ciphertext-v1",
			...DELEGATION_METADATA,
			refreshBefore: now + 1,
			expectedVersion: null,
		});
		const first = await stub.beginDelegationRefresh(DID, 100, now);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const second = await stub.beginDelegationRefresh(DID, 100, now + 101);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.lease.generation).toBe(first.lease.generation + 1);
		await expect(
			stub.releaseDelegationRefresh(DID, first.lease.generation, first.lease.token, now + 102),
		).resolves.toBe(false);
		await expect(
			stub.releaseDelegationRefresh(DID, second.lease.generation, second.lease.token, now + 102),
		).resolves.toBe(true);

		const revoked = await stub.revokeDelegation(DID, 1);
		expect(revoked).toMatchObject({
			ok: true,
			delegation: { status: "revoked", encryptedSession: "", encryptionKeyVersion: null },
		});
		await expect(stub.beginDelegationRefresh(DID, 100, now + 103)).resolves.toEqual({
			ok: false,
			code: "DELEGATION_UNAVAILABLE",
		});
	});

	it("persists canonical state across object restarts", async () => {
		const stub = publisher();
		await expect(
			stub.putDelegation({
				publisherDid: DID,
				releaseNsid: "com.emdashcms.experimental.package.release",
				scope:
					"atproto repo:com.emdashcms.experimental.package.release?action=create blob:application/gzip blob:image/*",
				clientKeyId: "assertion-1",
				encryptedSession: "persisted-ciphertext",
				...DELEGATION_METADATA,
				refreshBefore: null,
				expectedVersion: null,
			}),
		).resolves.toMatchObject({ ok: true });

		await abortAllDurableObjects();
		await expect(env.PUBLISHER_DO.getByName(DID).getDelegation(DID)).resolves.toMatchObject({
			encryptedSession: "persisted-ciphertext",
			stateVersion: 1,
		});
	});
});

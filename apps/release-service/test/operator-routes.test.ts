import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AccessActor } from "../src/access/auth.js";
import { loadConfiguration } from "../src/config.js";
import { SERVICE_CONTROL_OBJECT_NAME } from "../src/control-do/service-control-do.js";
import {
	handleCancelOperatorIntent,
	handleGetOperatorPublisher,
	handleReconcileOperatorIntent,
	handleRevokeOperatorPublisher,
	handleSetOperatorPublisherSuspension,
} from "../src/operator/routes.js";
import { createPublisherApplicationSession } from "../src/publisher-session/session.js";
import { TEST_BINDINGS } from "./fixtures/oauth.js";

const PUBLISHER_DID = "did:web:publisher.example.com";
const INTENT_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const NOW = 1_800_000_000_000;
const VIEWER: AccessActor = {
	realm: "access",
	identity: "viewer@example.com",
	email: "viewer@example.com",
	role: "viewer",
};
const REVIEWER: AccessActor = {
	realm: "access",
	identity: "reviewer@example.com",
	email: "reviewer@example.com",
	role: "reviewer",
};
const ADMIN: AccessActor = {
	realm: "access",
	identity: "admin@example.com",
	email: "admin@example.com",
	role: "admin",
};

function request(path: string, body: unknown, idempotencyKey: string): Request {
	return new Request(`${TEST_BINDINGS.PUBLIC_ORIGIN}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"idempotency-key": idempotencyKey,
		},
		body: JSON.stringify(body),
	});
}

async function createIntent(state: "ready" | "received" = "received") {
	const publisher = env.PUBLISHER_DO.getByName(PUBLISHER_DID);
	await publisher.putWorkloadPolicy({
		publisherDid: PUBLISHER_DID,
		packageSlug: "gallery",
		repository: "example/gallery",
		repositoryId: "123456789",
		repositoryOwnerId: "987654321",
		workflowRef: "example/gallery/.github/workflows/release.yml@refs/heads/main",
		allowedRefs: ["refs/heads/main"],
		allowedEnvironments: [],
		active: true,
		expectedVersion: null,
		now: NOW,
	});
	await publisher.createIntent({
		publisherDid: PUBLISHER_DID,
		intentId: INTENT_ID,
		packageSlug: "gallery",
		version: "1.2.3",
		workloadPolicyVersion: 1,
		workloadIdentityDigest: "A".repeat(43),
		workloadIdempotencyDigest: "I".repeat(43),
		idempotencyKey: "github-run-100-attempt-1",
		requestDigest: "B".repeat(43),
		workloadIdentityJson: '{"issuer":"github-actions"}',
		releaseInputJson: '{"release":{"package":"gallery","version":"1.2.3"}}',
		expiresAt: NOW + 60_000,
		now: NOW + 1,
	});
	if (state === "ready") {
		await publisher.transitionIntent({
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
		await publisher.transitionIntent({
			publisherDid: PUBLISHER_DID,
			intentId: INTENT_ID,
			expectedState: "verifying",
			expectedGeneration: 2,
			toState: "verified",
			transitionDigest: "D".repeat(43),
			actorRealm: "system",
			actorIdentity: "release-service",
			reasonCode: null,
			stateDataJson: "{}",
			now: NOW + 3,
		});
		await publisher.transitionIntent({
			publisherDid: PUBLISHER_DID,
			intentId: INTENT_ID,
			expectedState: "verified",
			expectedGeneration: 3,
			toState: "ready",
			transitionDigest: "E".repeat(43),
			actorRealm: "system",
			actorIdentity: "release-service",
			reasonCode: null,
			stateDataJson: "{}",
			now: NOW + 4,
		});
	}
	return publisher;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await reset();
});

describe("Access operator API", () => {
	it("suspends both global admission and the publisher shard before restoring either", async () => {
		const configuration = await loadConfiguration(TEST_BINDINGS);
		const createdSession = await createPublisherApplicationSession(
			env.PUBLISHER_DO,
			PUBLISHER_DID,
			NOW,
		);
		const suspended = await handleSetOperatorPublisherSuspension(
			request(
				`/admin/api/publishers/${PUBLISHER_DID}/suspend`,
				{ suspended: true, reasonCode: "ABUSE_REVIEW" },
				"suspend-publisher-test",
			),
			"request-1",
			configuration,
			{ publisherDid: PUBLISHER_DID },
			ADMIN,
		);
		expect(suspended.status).toBe(200);
		expect(await suspended.json()).toMatchObject({
			data: { publisher: { control: { status: "suspended" } } },
		});
		await expect(
			env.PUBLISHER_DO.getByName(PUBLISHER_DID).validatePublisherSession(
				PUBLISHER_DID,
				"A".repeat(43),
				null,
			),
		).resolves.toMatchObject({ ok: false, code: "PUBLISHER_SUSPENDED" });
		expect(createdSession.session.publisherDid).toBe(PUBLISHER_DID);

		const restored = await handleSetOperatorPublisherSuspension(
			request(
				`/admin/api/publishers/${PUBLISHER_DID}/suspend`,
				{ suspended: false, reasonCode: null },
				"restore-publisher-test",
			),
			"request-2",
			configuration,
			{ publisherDid: PUBLISHER_DID },
			ADMIN,
		);
		expect(restored.status).toBe(200);
		expect(await restored.json()).toMatchObject({
			data: { publisher: { control: { status: "allowed" } } },
		});
		await expect(
			env.SERVICE_CONTROL_DO.getByName(SERVICE_CONTROL_OBJECT_NAME).getAdmissionDecision(
				PUBLISHER_DID,
			),
		).resolves.toMatchObject({ allowed: true });
	});

	it("returns sanitized state and revokes retained authority and publisher sessions", async () => {
		const configuration = await loadConfiguration(TEST_BINDINGS);
		await createPublisherApplicationSession(env.PUBLISHER_DO, PUBLISHER_DID, NOW);
		const publisher = env.PUBLISHER_DO.getByName(PUBLISHER_DID);
		await publisher.putDelegation({
			publisherDid: PUBLISHER_DID,
			releaseNsid: configuration.oauth.releaseNsid,
			scope: configuration.oauth.releaseScope,
			clientKeyId: configuration.oauth.activeAssertionKeyId,
			encryptedSession: "encrypted-session-secret",
			encryptionKeyVersion: 1,
			issuer: "https://authorization.example.com",
			pdsUrl: "https://pds.example.com",
			expiresAt: null,
			refreshBefore: null,
			expectedVersion: null,
		});
		const read = await handleGetOperatorPublisher(
			new Request(`${TEST_BINDINGS.PUBLIC_ORIGIN}/admin/api/publishers/${PUBLISHER_DID}`),
			"request-1",
			configuration,
			{ publisherDid: PUBLISHER_DID },
			VIEWER,
		);
		const readValue = await read.json();
		expect(readValue).toMatchObject({
			data: { publisher: { delegation: { status: "active" } } },
		});
		expect(JSON.stringify(readValue)).not.toContain("encrypted-session-secret");

		const revoked = await handleRevokeOperatorPublisher(
			request(`/admin/api/publishers/${PUBLISHER_DID}/revoke`, {}, "revoke-publisher-test"),
			"request-2",
			configuration,
			{ publisherDid: PUBLISHER_DID },
			ADMIN,
		);
		expect(revoked.status).toBe(200);
		expect(await revoked.json()).toMatchObject({
			data: { publisher: { delegation: { status: "revoked", stateVersion: 2 } } },
		});
		const audit = await runInDurableObject(publisher, (_instance, state) =>
			state.storage.sql
				.exec<{ actor_identity: string; actor_realm: string; event_type: string }>(
					`SELECT event_type, actor_realm, actor_identity FROM audit_events
					 WHERE event_type IN ('delegation-revoked', 'publisher-sessions-revoked')
					 ORDER BY sequence`,
				)
				.toArray(),
		);
		expect(audit).toEqual([
			{ event_type: "delegation-revoked", actor_realm: "access", actor_identity: ADMIN.identity },
			{
				event_type: "publisher-sessions-revoked",
				actor_realm: "access",
				actor_identity: ADMIN.identity,
			},
		]);
	});

	it("cancels an unpublished intent with an Access audit identity", async () => {
		const configuration = await loadConfiguration(TEST_BINDINGS);
		const publisher = await createIntent();
		const response = await handleCancelOperatorIntent(
			request(
				`/admin/api/intents/${INTENT_ID}/cancel`,
				{ publisherDid: PUBLISHER_DID },
				"cancel-intent-test",
			),
			"request-1",
			configuration,
			{ intentId: INTENT_ID },
			REVIEWER,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			data: { intent: { state: "cancelled", reasonCode: "OPERATOR_CANCELLED" } },
		});
		await expect(publisher.listIntentTransitions(PUBLISHER_DID, INTENT_ID)).resolves.toMatchObject([
			{},
			{ actorRealm: "access", actorIdentity: REVIEWER.identity, toState: "cancelled" },
		]);
	});

	it("starts bounded reconciliation only for a recoverable intent", async () => {
		const configuration = await loadConfiguration(TEST_BINDINGS);
		await createIntent("ready");
		const restartWorkflow = vi.fn(async () => ({
			ok: true as const,
			workflowId: INTENT_ID,
			restarted: true,
		}));
		const response = await handleReconcileOperatorIntent(
			request(
				`/admin/api/intents/${INTENT_ID}/reconcile`,
				{ publisherDid: PUBLISHER_DID },
				"reconcile-intent-test",
			),
			"request-1",
			configuration,
			{ intentId: INTENT_ID },
			REVIEWER,
			{ restartWorkflow },
		);
		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({ data: { restarted: true } });
		expect(restartWorkflow).toHaveBeenCalledOnce();
	});
});

import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfiguration } from "../src/config.js";
import { createPublisherApplicationSession } from "../src/publisher-session/session.js";
import {
	handleDisablePublisherWorkload,
	handleGetPublisher,
	handleListPublisherIntents,
	handleListPublisherWorkloads,
	handlePutPublisherWorkload,
	handleRevokePublisherDelegation,
} from "../src/publisher/routes.js";
import { TEST_BINDINGS } from "./fixtures/oauth.js";

const PUBLISHER_DID = "did:web:publisher.example.com";
const INTENT_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const NOW = 1_800_000_000_000;

function cookieValue(header: string): string {
	return header.split(";", 1)[0] ?? "";
}

async function sessionHeaders(mutation = false): Promise<Headers> {
	const session = await createPublisherApplicationSession(env.PUBLISHER_DO, PUBLISHER_DID, NOW);
	const headers = new Headers({
		cookie: session.setCookieHeaders.map(cookieValue).join("; "),
	});
	if (mutation) {
		const csrf = cookieValue(session.setCookieHeaders[1]).split("=", 2)[1] ?? "";
		headers.set("content-type", "application/json");
		headers.set("idempotency-key", "publisher-route-mutation");
		headers.set("origin", TEST_BINDINGS.PUBLIC_ORIGIN);
		headers.set("x-emdash-request", "1");
		headers.set("x-emdash-csrf", csrf);
	}
	return headers;
}

function request(path: string, headers: Headers, method = "GET", body?: unknown): Request {
	return new Request(`${TEST_BINDINGS.PUBLIC_ORIGIN}${path}`, {
		method,
		headers,
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

function policyBody(expectedVersion: number | null = null) {
	return {
		packageSlug: "gallery",
		repository: "example/gallery",
		repositoryId: "123456789",
		repositoryOwnerId: "987654321",
		workflowRef: "example/gallery/.github/workflows/release.yml@refs/heads/main",
		allowedRefs: ["refs/heads/main"],
		allowedEnvironments: [],
		expectedVersion,
	};
}

afterEach(async () => {
	await reset();
});

describe("publisher API", () => {
	it("returns only sanitized publisher and delegation state", async () => {
		const configuration = await loadConfiguration(TEST_BINDINGS);
		const headers = await sessionHeaders();
		await env.PUBLISHER_DO.getByName(PUBLISHER_DID).putDelegation({
			publisherDid: PUBLISHER_DID,
			releaseNsid: configuration.oauth.releaseNsid,
			scope: configuration.oauth.releaseScope,
			clientKeyId: configuration.oauth.activeAssertionKeyId,
			encryptedSession: "encrypted-session-secret",
			encryptionKeyVersion: 1,
			issuer: "https://authorization.example.com",
			pdsUrl: "https://pds.example.com",
			expiresAt: NOW + 60_000,
			refreshBefore: NOW + 30_000,
			expectedVersion: null,
		});

		const response = await handleGetPublisher(
			request("/v1/publisher", headers),
			"request-1",
			configuration,
		);
		expect(response.status).toBe(200);
		const value = await response.json();
		expect(value).toMatchObject({
			data: {
				publisher: {
					did: PUBLISHER_DID,
					delegation: { status: "active", stateVersion: 1 },
				},
			},
		});
		expect(JSON.stringify(value)).not.toContain("encrypted-session-secret");
		expect(JSON.stringify(value)).not.toContain(configuration.oauth.activeAssertionKeyId);
	});

	it("creates, replays, lists, and disables a workload policy with CSRF and CAS", async () => {
		const configuration = await loadConfiguration(TEST_BINDINGS);
		const createHeaders = await sessionHeaders(true);
		const created = await handlePutPublisherWorkload(
			request("/v1/publisher/workloads", createHeaders, "POST", policyBody()),
			"request-1",
			configuration,
		);
		expect(created.status).toBe(201);
		expect(await created.json()).toMatchObject({
			data: { policy: { packageSlug: "gallery", active: true, stateVersion: 1 }, replayed: false },
		});

		const replayHeaders = await sessionHeaders(true);
		const replay = await handlePutPublisherWorkload(
			request("/v1/publisher/workloads", replayHeaders, "POST", policyBody()),
			"request-2",
			configuration,
		);
		expect(replay.status).toBe(200);
		expect(await replay.json()).toMatchObject({ data: { replayed: true } });

		const list = await handleListPublisherWorkloads(
			request("/v1/publisher/workloads?limit=1", await sessionHeaders()),
			"request-3",
			configuration,
		);
		expect(await list.json()).toMatchObject({
			data: { items: [{ packageSlug: "gallery", active: true }] },
		});

		const disableHeaders = await sessionHeaders(true);
		const disabled = await handleDisablePublisherWorkload(
			request("/v1/publisher/workloads/gallery", disableHeaders, "DELETE", {
				expectedVersion: 1,
			}),
			"request-4",
			configuration,
			{ packageSlug: "gallery" },
		);
		expect(disabled.status).toBe(200);
		expect(await disabled.json()).toMatchObject({
			data: { policy: { active: false, stateVersion: 2 }, replayed: false },
		});
	});

	it("lists only intents from the authenticated publisher shard", async () => {
		const configuration = await loadConfiguration(TEST_BINDINGS);
		const publisher = env.PUBLISHER_DO.getByName(PUBLISHER_DID);
		await publisher.putWorkloadPolicy({
			publisherDid: PUBLISHER_DID,
			...policyBody(),
			active: true,
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

		const response = await handleListPublisherIntents(
			request("/v1/publisher/intents", await sessionHeaders()),
			"request-1",
			configuration,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			data: { items: [{ id: INTENT_ID, publisherDid: PUBLISHER_DID }] },
		});
	});

	it("revokes retained authority idempotently without exposing OAuth errors", async () => {
		const configuration = await loadConfiguration(TEST_BINDINGS);
		const publisher = env.PUBLISHER_DO.getByName(PUBLISHER_DID);
		await sessionHeaders();
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
		const headers = await sessionHeaders(true);
		const response = await handleRevokePublisherDelegation(
			request("/v1/publisher/delegation", headers, "DELETE", {}),
			"request-1",
			configuration,
			{
				revokeDelegation: async (publisherDid) => {
					const current = await publisher.getDelegation(publisherDid);
					if (!current) throw new Error("Expected delegation");
					await publisher.revokeDelegation(publisherDid, current.stateVersion);
				},
			},
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			data: { publisher: { delegation: { status: "revoked", stateVersion: 2 } } },
		});
	});
});

import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import { evaluateWorkloadPolicy } from "../src/workload/policy.js";
import type { VerifiedWorkloadIdentity } from "../src/workload/types.js";

const PUBLISHER_DID = "did:web:publisher.example.com";
const REQUEST_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const NOW = 1_800_000_000_000;

const CLAIM = {
	repository: "example/gallery",
	repositoryId: "123456789",
	repositoryOwner: "example",
	repositoryOwnerId: "987654321",
	repositoryVisibility: "private" as const,
	workflowRef: "example/gallery/.github/workflows/release.yml@refs/heads/main",
	ref: "refs/tags/v1.2.3",
	environment: "production",
};

function identity(ref: string): VerifiedWorkloadIdentity {
	return {
		issuer: "github-actions",
		subject: `repo:example/gallery:ref:${ref}`,
		tokenId: crypto.randomUUID(),
		repository: {
			name: CLAIM.repository,
			id: CLAIM.repositoryId,
			owner: CLAIM.repositoryOwner,
			ownerId: CLAIM.repositoryOwnerId,
			visibility: CLAIM.repositoryVisibility,
		},
		workflow: {
			ref: CLAIM.workflowRef,
			sha: "a".repeat(40),
			jobRef: null,
			jobSha: null,
		},
		run: {
			id: "10000000001",
			attempt: 1,
			actor: "release-bot",
			actorId: "11223344",
			eventName: "push",
			ref,
			refType: "tag",
			commitSha: "b".repeat(40),
			environment: CLAIM.environment,
			runnerEnvironment: "github-hosted",
		},
		issuedAt: 1_800_000_000,
		expiresAt: 1_800_000_300,
	};
}

async function enablePublishing() {
	const publisher = env.PUBLISHER_DO.getByName(PUBLISHER_DID);
	await publisher.putDelegation({
		publisherDid: PUBLISHER_DID,
		releaseNsid: "com.emdashcms.experimental.package.release",
		scope:
			"atproto repo:com.emdashcms.experimental.package.release?action=create blob:application/gzip blob:image/*",
		clientKeyId: "test-key",
		encryptedSession: "encrypted-session",
		encryptionKeyVersion: 1,
		issuer: "https://authorization.example.com",
		pdsUrl: "https://pds.example.com",
		expiresAt: null,
		refreshBefore: null,
		expectedVersion: null,
	});
	await publisher.createWorkflowConnectionInvitation({
		publisherDid: PUBLISHER_DID,
		tokenHash: "I".repeat(43),
		packageSlug: "gallery",
		expiresAt: NOW + 30 * 60_000,
		now: NOW,
	});
}

function requestInput(overrides: Record<string, unknown> = {}) {
	return {
		publisherDid: PUBLISHER_DID,
		requestId: REQUEST_ID,
		mutationKey: "workflow-connection-request-0001",
		connectionKey: "K".repeat(43),
		invitationTokenHash: "I".repeat(43),
		packageSlug: "gallery",
		claim: CLAIM,
		expiresAt: NOW + 30 * 60_000,
		now: NOW,
		...overrides,
	};
}

afterEach(async () => {
	await reset();
});

describe("GitHub workflow connection requests", () => {
	it("requires publishing authority before accepting a workflow request", async () => {
		await expect(
			env.PUBLISHER_DO.getByName(PUBLISHER_DID).requestWorkflowConnection(requestInput()),
		).resolves.toEqual({ ok: false, code: "DELEGATION_REQUIRED" });
	});

	it("creates authority only after publisher confirmation and permits future version tags", async () => {
		await enablePublishing();
		const publisher = env.PUBLISHER_DO.getByName(PUBLISHER_DID);
		await expect(publisher.requestWorkflowConnection(requestInput())).resolves.toMatchObject({
			ok: true,
			status: "pending",
			replayed: false,
			request: { state: "pending", claim: CLAIM },
		});
		await expect(publisher.getWorkloadPolicy(PUBLISHER_DID, "gallery")).resolves.toBeNull();

		const confirmed = await publisher.confirmWorkflowConnection(
			PUBLISHER_DID,
			REQUEST_ID,
			"version_tags",
			NOW + 1,
		);
		expect(confirmed).toMatchObject({
			ok: true,
			replayed: false,
			request: { state: "confirmed", refScope: "version_tags" },
			policy: {
				workflowRef: CLAIM.workflowRef,
				allowedRefs: ["refs/tags/*"],
				allowedEnvironments: ["production"],
			},
		});
		if (!confirmed.ok) return;
		expect(evaluateWorkloadPolicy(identity("refs/tags/v2.0.0"), confirmed.policy)).toEqual({
			ok: true,
		});
		await expect(
			publisher.requestWorkflowConnection(
				requestInput({
					requestId: "01JABCDEFGHJKMNPQRSTVWXYZ1",
					mutationKey: "workflow-connection-request-0002",
					connectionKey: "L".repeat(43),
					claim: { ...CLAIM, ref: "refs/tags/v2.0.0" },
					now: NOW + 2,
				}),
			),
		).resolves.toMatchObject({ ok: true, status: "connected" });
	});

	it("deduplicates matching requests and expires unconfirmed requests", async () => {
		await enablePublishing();
		const publisher = env.PUBLISHER_DO.getByName(PUBLISHER_DID);
		await publisher.requestWorkflowConnection(requestInput({ expiresAt: NOW + 60_000 }));
		await expect(
			publisher.requestWorkflowConnection(
				requestInput({
					requestId: "01JABCDEFGHJKMNPQRSTVWXYZ1",
					mutationKey: "workflow-connection-request-0002",
					now: NOW + 1,
					expiresAt: NOW + 60_000,
				}),
			),
		).resolves.toMatchObject({
			ok: true,
			status: "pending",
			replayed: true,
			request: { id: REQUEST_ID },
		});
		await expect(
			publisher.listWorkflowConnectionRequests(PUBLISHER_DID, 20, NOW + 60_001),
		).resolves.toEqual([]);
	});
});

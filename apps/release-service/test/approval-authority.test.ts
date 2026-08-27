import type { ActorResolver } from "@atcute/identity-resolver";
import { NSID } from "@emdash-cms/registry-lexicons";
import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import {
	ApprovalAuthorityError,
	loadApprovalIntent,
	verifyCurrentApprover,
} from "../src/approvals/authority.js";
import { encodeAwaitingApprovalState, type ApprovalEvidence } from "../src/approvals/digest.js";

const PUBLISHER_DID = "did:plc:publisher";
const APPROVER_DID = "did:plc:approver";
const INTENT_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const NOW = 1_800_000_000_000;
const PROFILE_CID = "bafyreib3p6qexampleprofilecid";

const EVIDENCE: ApprovalEvidence = {
	intentId: INTENT_ID,
	publisherDid: PUBLISHER_DID,
	packageSlug: "gallery",
	version: "1.2.3",
	verificationGeneration: 4,
	workloadIdentityDigest: "A".repeat(43),
	releaseInputDigest: "B".repeat(43),
	profileCid: PROFILE_CID,
	baselineReleaseCid: null,
	artifactChecksum: "sha256:0123456789abcdef",
	provenanceChecksum: "sha256:fedcba9876543210",
	declaredAccessDiffDigest: "C".repeat(43),
	verificationDigest: "D".repeat(43),
};

function publisher() {
	return env.PUBLISHER_DO.getByName(PUBLISHER_DID);
}

async function createAwaitingApprovalIntent() {
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
		transitionDigest: "E".repeat(43),
		actorRealm: "system",
		actorIdentity: "release-service",
		reasonCode: null,
		stateDataJson: "{}",
		workflowId: "workflow-approval-test",
		now: NOW + 2,
	});
	await stub.transitionIntent({
		publisherDid: PUBLISHER_DID,
		intentId: INTENT_ID,
		expectedState: "verifying",
		expectedGeneration: 2,
		toState: "verified",
		transitionDigest: "F".repeat(43),
		actorRealm: "system",
		actorIdentity: "release-service",
		reasonCode: null,
		stateDataJson: "{}",
		now: NOW + 3,
	});
	await stub.transitionIntent({
		publisherDid: PUBLISHER_DID,
		intentId: INTENT_ID,
		expectedState: "verified",
		expectedGeneration: 3,
		toState: "awaiting_approval",
		transitionDigest: "G".repeat(43),
		actorRealm: "system",
		actorIdentity: "release-service",
		reasonCode: "APPROVAL_REQUIRED",
		stateDataJson: await encodeAwaitingApprovalState(EVIDENCE, [APPROVER_DID]),
		now: NOW + 4,
	});
}

function actorResolver(): ActorResolver {
	return {
		resolve: async () => ({
			did: PUBLISHER_DID,
			handle: "publisher.example.com",
			pds: "https://pds.example.com",
		}),
	};
}

function profileValue(approvers: string[] = [APPROVER_DID]) {
	return {
		$type: NSID.packageProfile,
		authors: [{ name: "Publisher" }],
		id: `at://${PUBLISHER_DID}/${NSID.packageProfile}/gallery`,
		license: "MIT",
		security: [{ email: "security@example.com" }],
		type: "emdash-plugin",
		extensions: {
			[NSID.packageProfileExtension]: {
				repository: "https://github.com/emdash-cms/gallery",
				releasePolicy: { confirmation: "always", approvers },
			},
		},
	};
}

function authorityFetch(options: { approvers?: string[]; cid?: string; address?: string } = {}) {
	return async (input: RequestInfo | URL): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		if (url.hostname === "cloudflare-dns.com") {
			return Response.json({
				Status: 0,
				Answer:
					url.searchParams.get("type") === "A"
						? [{ type: 1, data: options.address ?? "93.184.216.34" }]
						: [],
			});
		}
		if (url.hostname === "pds.example.com" && url.pathname === "/xrpc/com.atproto.repo.getRecord") {
			return Response.json({
				uri: `at://${PUBLISHER_DID}/${NSID.packageProfile}/gallery`,
				cid: options.cid ?? PROFILE_CID,
				value: profileValue(options.approvers),
			});
		}
		throw new Error(`Unexpected request: ${url.toString()}`);
	};
}

afterEach(async () => {
	await reset();
});

describe("approval authority", () => {
	it("loads the immutable approval evidence from transition history", async () => {
		await createAwaitingApprovalIntent();

		await expect(
			loadApprovalIntent(env.PUBLISHER_DO, PUBLISHER_DID, INTENT_ID),
		).resolves.toMatchObject({
			evidence: EVIDENCE,
			approvalGeneration: 4,
			intent: { state: "awaiting_approval" },
		});
	});

	it("rejects substituted approval evidence", async () => {
		await createAwaitingApprovalIntent();
		await runInDurableObject(publisher(), (_instance, state) => {
			state.storage.sql.exec(
				`UPDATE intent_transitions SET state_data_json = '{}'
				 WHERE intent_id = ? AND to_state = 'awaiting_approval'`,
				INTENT_ID,
			);
		});

		await expect(
			loadApprovalIntent(env.PUBLISHER_DO, PUBLISHER_DID, INTENT_ID),
		).rejects.toMatchObject({ code: "APPROVAL_EVIDENCE_INVALID" });
	});

	it("rejects an expired intent before a passkey decision", async () => {
		await createAwaitingApprovalIntent();
		await runInDurableObject(publisher(), (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE intents SET expires_at = ? WHERE id = ?",
				Date.now() - 1,
				INTENT_ID,
			);
		});

		await expect(
			loadApprovalIntent(env.PUBLISHER_DO, PUBLISHER_DID, INTENT_ID),
		).rejects.toMatchObject({ code: "INTENT_NOT_APPROVABLE" });
	});

	it("accepts only a currently listed approver at the exact profile CID", async () => {
		await expect(
			verifyCurrentApprover(EVIDENCE, APPROVER_DID, {
				actorResolver: actorResolver(),
				fetch: authorityFetch(),
			}),
		).resolves.toBeUndefined();
		await expect(
			verifyCurrentApprover(EVIDENCE, APPROVER_DID, {
				actorResolver: actorResolver(),
				fetch: authorityFetch({ approvers: ["did:plc:other"] }),
			}),
		).rejects.toMatchObject({ code: "APPROVER_NOT_AUTHORIZED" });
		await expect(
			verifyCurrentApprover(EVIDENCE, APPROVER_DID, {
				actorResolver: actorResolver(),
				fetch: authorityFetch({ cid: "bafyreib3p6qchangedprofilecid" }),
			}),
		).rejects.toMatchObject({ code: "PROFILE_CHANGED" });
	});

	it("rejects private PDS resolution before fetching the record", async () => {
		await expect(
			verifyCurrentApprover(EVIDENCE, APPROVER_DID, {
				actorResolver: actorResolver(),
				fetch: authorityFetch({ address: "10.0.0.1" }),
			}),
		).rejects.toBeInstanceOf(ApprovalAuthorityError);
	});

	it("rejects private DID-web resolution before fetching the DID document", async () => {
		let didDocumentFetched = false;
		const fetch = async (input: RequestInfo | URL): Promise<Response> => {
			const url = new URL(input instanceof Request ? input.url : input.toString());
			if (url.hostname === "cloudflare-dns.com") {
				return Response.json({
					Status: 0,
					Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: "10.0.0.1" }] : [],
				});
			}
			didDocumentFetched = true;
			throw new Error("DID document fetch must not occur");
		};
		await expect(
			verifyCurrentApprover(
				{ ...EVIDENCE, publisherDid: "did:web:publisher.example.com" },
				APPROVER_DID,
				{ fetch },
			),
		).rejects.toMatchObject({ code: "PROFILE_FETCH_FAILED" });
		expect(didDocumentFetched).toBe(false);
	});
});

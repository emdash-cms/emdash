import type { DirectPdsDidDocumentResolver } from "@emdash-cms/registry-client/direct-pds";
import { NSID } from "@emdash-cms/registry-lexicons";
import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import {
	ApprovalAuthorityError,
	loadCurrentApprovalPolicy,
	loadApprovalIntent,
	verifyCurrentApprover,
} from "../src/approvals/authority.js";
import { encodeAwaitingApprovalState, type ApprovalEvidence } from "../src/approvals/digest.js";

const PUBLISHER_DID = "did:plc:publisher";
const APPROVER_DID = "did:plc:approver";
const INTENT_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const NOW = 1_800_000_000_000;
const PROFILE_CID = "bafyreie3bcpcntqlswxk32ibe4v2cvhhvaq7gcx6css2vuzasirgk3xmly";
const PROFILE_PROOF =
	"OqJlcm9vdHOB2CpYJQABcRIguIOtOxeeD6PfhhwV1Tbcy0g1a5TRE+tSQA0QlhEj6FRndmVyc2lvbgHQAQFxEiC4g607F54Po9+GHBXVNtzLSDVrlNET61JADRCWESPoVKZjZGlkcWRpZDpwbGM6cHVibGlzaGVyY3Jldm0zbXVqa3M1bG53azI0Y3NpZ1hA4lFxxn7YC9lg4/mEb9l7Lb+uN+8EzZvH6XsUrpCbtNg+kr0+VIQArQba1jZajQL4pc1IeP6Oq1KRWPcVGKZpTGRkYXRh2CpYJQABcRIg5rQ4qhRh79SdMF1zLkkklmnQjgkMGK7mrU2HiQJnRYtkcHJldvZndmVyc2lvbgOXAgFxEiDmtDiqFGHv1J0wXXMuSSSWadCOCQwYruatTYeJAmdFi6JhZYOkYWtYMmNvbS5lbWRhc2hjbXMuZXhwZXJpbWVudGFsLnBhY2thZ2UucHJvZmlsZS9nYWxsZXJ5YXAAYXT2YXbYKlglAAFxEiCbCJ4mzguVrq3pAScroVTnqCHzCv4UparTIJIiZW7sXqRha1VyZWxlYXNlL2dhbGxlcnk6MS4wLjBhcBgjYXT2YXbYKlglAAFxEiAVgbNAcHSSrRFFo3roii2+pXMBVGSC2AOYbrJfAzWLwqRha0M3LjBhcBg1YXT2YXbYKlglAAFxEiBhFDeoEsxJobozp3Y26kHUHywaIc1posb8QrJvJtD0DWFs9roEAXESIJsInibOC5WurekBJyuhVOeoIfMK/hSlqtMgkiJlbuxep2JpZHhJYXQ6Ly9kaWQ6cGxjOnB1Ymxpc2hlci9jb20uZW1kYXNoY21zLmV4cGVyaW1lbnRhbC5wYWNrYWdlLnByb2ZpbGUvZ2FsbGVyeWR0eXBlbWVtZGFzaC1wbHVnaW5lJHR5cGV4KmNvbS5lbWRhc2hjbXMuZXhwZXJpbWVudGFsLnBhY2thZ2UucHJvZmlsZWdhdXRob3JzgaFkbmFtZWlQdWJsaXNoZXJnbGljZW5zZWNNSVRoc2VjdXJpdHmBoWVlbWFpbHRzZWN1cml0eUBleGFtcGxlLmNvbWpleHRlbnNpb25zoXgzY29tLmVtZGFzaGNtcy5leHBlcmltZW50YWwucGFja2FnZS5wcm9maWxlRXh0ZW5zaW9uo2UkdHlwZXgzY29tLmVtZGFzaGNtcy5leHBlcmltZW50YWwucGFja2FnZS5wcm9maWxlRXh0ZW5zaW9uanJlcG9zaXRvcnl4JWh0dHBzOi8vZ2l0aHViLmNvbS9lbWRhc2gtY21zL2dhbGxlcnltcmVsZWFzZVBvbGljeaNlJHR5cGV4QWNvbS5lbWRhc2hjbXMuZXhwZXJpbWVudGFsLnBhY2thZ2UucHJvZmlsZUV4dGVuc2lvbiNyZWxlYXNlUG9saWN5aWFwcHJvdmVyc4FwZGlkOnBsYzphcHByb3Zlcmxjb25maXJtYXRpb25mYWx3YXlz";

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

function proofResolver(): DirectPdsDidDocumentResolver {
	return {
		resolve: () =>
			Promise.resolve({
				id: PUBLISHER_DID,
				verificationMethod: [
					{
						id: `${PUBLISHER_DID}#atproto`,
						type: "Multikey",
						controller: PUBLISHER_DID,
						publicKeyMultibase: "zDnaejExR13CZ7p99ojitvboj6ZaYzxhMDqJwnZd7APbohKkR",
					},
				],
				service: [
					{
						id: "#atproto_pds",
						type: "AtprotoPersonalDataServer",
						serviceEndpoint: "https://pds.example.com",
					},
				],
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

function authorityFetch(
	options: {
		approvers?: string[];
		cid?: string;
		address?: string;
		requireCarAccept?: boolean;
		missing?: boolean;
	} = {},
) {
	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
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
		if (url.hostname === "pds.example.com" && url.pathname === "/xrpc/com.atproto.sync.getRecord") {
			if (options.missing) {
				return Response.json({ error: "RecordNotFound" }, { status: 404 });
			}
			if (
				options.requireCarAccept &&
				new Headers(init?.headers).get("accept") !== "application/vnd.ipld.car"
			) {
				return Response.json({ error: "NotAcceptable" }, { status: 406 });
			}
			const bytes = Uint8Array.from(atob(PROFILE_PROOF), (character) => character.charCodeAt(0));
			return new Response(bytes, {
				headers: { "content-type": "application/vnd.ipld.car" },
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
			approverDids: [APPROVER_DID],
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

	it("accepts only an immutable approver at the exact proof-verified profile CID", async () => {
		await expect(
			verifyCurrentApprover(EVIDENCE, [APPROVER_DID], APPROVER_DID, {
				didDocumentResolver: proofResolver(),
				fetch: authorityFetch(),
			}),
		).resolves.toBeUndefined();
		await expect(
			verifyCurrentApprover(EVIDENCE, ["did:plc:other"], APPROVER_DID, {
				didDocumentResolver: proofResolver(),
				fetch: authorityFetch({ approvers: [APPROVER_DID] }),
			}),
		).rejects.toMatchObject({ code: "APPROVER_NOT_AUTHORIZED" });
		await expect(
			verifyCurrentApprover(EVIDENCE, [APPROVER_DID], APPROVER_DID, {
				didDocumentResolver: proofResolver(),
				fetch: authorityFetch({ approvers: ["did:plc:attacker"], cid: PROFILE_CID }),
			}),
		).resolves.toBeUndefined();
	});

	it("loads the current signed approver policy for publisher status views", async () => {
		await expect(
			loadCurrentApprovalPolicy(PUBLISHER_DID, "gallery", {
				didDocumentResolver: proofResolver(),
				fetch: authorityFetch(),
			}),
		).resolves.toEqual({
			profileCid: PROFILE_CID,
			approverDids: [APPROVER_DID],
			repository: "https://github.com/emdash-cms/gallery",
		});
		await expect(
			loadCurrentApprovalPolicy(PUBLISHER_DID, "gallery", {
				didDocumentResolver: proofResolver(),
				fetch: authorityFetch({ approvers: [APPROVER_DID, APPROVER_DID] }),
			}),
		).resolves.toEqual({
			profileCid: EVIDENCE.profileCid,
			approverDids: [APPROVER_DID],
			repository: "https://github.com/emdash-cms/gallery",
		});
	});

	it("requests the current profile as a repository proof CAR", async () => {
		await expect(
			loadCurrentApprovalPolicy(PUBLISHER_DID, "gallery", {
				didDocumentResolver: proofResolver(),
				fetch: authorityFetch({ requireCarAccept: true }),
			}),
		).resolves.toEqual({
			profileCid: PROFILE_CID,
			approverDids: [APPROVER_DID],
			repository: "https://github.com/emdash-cms/gallery",
		});
	});

	it("distinguishes a missing profile from a transient profile read failure", async () => {
		await expect(
			loadCurrentApprovalPolicy(PUBLISHER_DID, "gallery", {
				didDocumentResolver: proofResolver(),
				fetch: authorityFetch({ missing: true }),
			}),
		).rejects.toMatchObject({ code: "PROFILE_NOT_FOUND" });
	});

	it("rejects private PDS resolution before fetching the record", async () => {
		await expect(
			verifyCurrentApprover(EVIDENCE, [APPROVER_DID], APPROVER_DID, {
				didDocumentResolver: proofResolver(),
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
				[APPROVER_DID],
				APPROVER_DID,
				{ fetch },
			),
		).rejects.toMatchObject({ code: "PROFILE_FETCH_FAILED" });
		expect(didDocumentFetched).toBe(false);
	});
});

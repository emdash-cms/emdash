import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { NSID } from "@emdash-cms/registry-lexicons";
import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { encodeAwaitingApprovalState, type ApprovalEvidence } from "../src/approvals/digest.js";
import { createApproverApplicationSession } from "../src/approver-session/session.js";
import { handleRequest } from "../src/index.js";
import { TEST_BINDINGS } from "./fixtures/oauth.js";

const ORIGIN = "https://release.example.com";
const PUBLISHER_DID = "did:web:publisher.example.com";
const APPROVER_DID = "did:plc:approver";
const ATTACKER_DID = "did:plc:attacker";
const INTENT_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const CREDENTIAL_ID = "approval-credential";
const PROFILE_CID = "bafyreielha65mr3o2wgupjyglbhdujvq3k7isfkz5uejbjnevnypmdk2wi";
const PROFILE_PROOF =
	"OqJlcm9vdHOB2CpYJQABcRIgR1ivuJdVA3NEw+prJcQhhJXHGT6zcyewmDKjkr37ZjtndmVyc2lvbgHdAQFxEiBHWK+4l1UDc0TD6mslxCGElccZPrNzJ7CYMqOSvftmO6ZjZGlkeB1kaWQ6d2ViOnB1Ymxpc2hlci5leGFtcGxlLmNvbWNyZXZtM211amtzNW03ajIyNGNzaWdYQDTT+fQkfkx6l1l21oVamQWReNbzhS8P2OIbYdL2HmLqbDtCJ13YECxuhEtcDOB598dPFcWGruof+EgnC220ivBkZGF0YdgqWCUAAXESIPRNAAbvLpqyxQsY9xwRwEoJlpJUttI1VoLAT7F1PUGRZHByZXb2Z3ZlcnNpb24DkwEBcRIg9E0ABu8umrLFCxj3HBHASgmWklS20jVWgsBPsXU9QZGiYWWBpGFrWDJjb20uZW1kYXNoY21zLmV4cGVyaW1lbnRhbC5wYWNrYWdlLnByb2ZpbGUvZ2FsbGVyeWFwAGF09mF22CpYJQABcRIgizg91kdu1Y1HpwZYTjomsNq+iRVZ7QiQpaSrcPYNWrJhbPbGBAFxEiCLOD3WR27VjUenBlhOOiaw2r6JFVntCJClpKtw9g1asqdiaWR4VWF0Oi8vZGlkOndlYjpwdWJsaXNoZXIuZXhhbXBsZS5jb20vY29tLmVtZGFzaGNtcy5leHBlcmltZW50YWwucGFja2FnZS5wcm9maWxlL2dhbGxlcnlkdHlwZW1lbWRhc2gtcGx1Z2luZSR0eXBleCpjb20uZW1kYXNoY21zLmV4cGVyaW1lbnRhbC5wYWNrYWdlLnByb2ZpbGVnYXV0aG9yc4GhZG5hbWVpUHVibGlzaGVyZ2xpY2Vuc2VjTUlUaHNlY3VyaXR5gaFlZW1haWx0c2VjdXJpdHlAZXhhbXBsZS5jb21qZXh0ZW5zaW9uc6F4M2NvbS5lbWRhc2hjbXMuZXhwZXJpbWVudGFsLnBhY2thZ2UucHJvZmlsZUV4dGVuc2lvbqNlJHR5cGV4M2NvbS5lbWRhc2hjbXMuZXhwZXJpbWVudGFsLnBhY2thZ2UucHJvZmlsZUV4dGVuc2lvbmpyZXBvc2l0b3J5eCVodHRwczovL2dpdGh1Yi5jb20vZW1kYXNoLWNtcy9nYWxsZXJ5bXJlbGVhc2VQb2xpY3mjZSR0eXBleEFjb20uZW1kYXNoY21zLmV4cGVyaW1lbnRhbC5wYWNrYWdlLnByb2ZpbGVFeHRlbnNpb24jcmVsZWFzZVBvbGljeWlhcHByb3ZlcnOBcGRpZDpwbGM6YXBwcm92ZXJsY29uZmlybWF0aW9uZmFsd2F5cw==";
const NOW = 1_800_000_000_000;
const WORKLOAD_IDENTITY = {
	issuer: "github-actions",
	subject: "repo:emdash-cms/gallery:ref:refs/heads/main",
	tokenId: "release-token-100",
	repository: {
		name: "emdash-cms/gallery",
		id: "123456789",
		owner: "emdash-cms",
		ownerId: "987654321",
		visibility: "public",
	},
	workflow: {
		ref: "emdash-cms/gallery/.github/workflows/release.yml@refs/heads/main",
		sha: "b".repeat(40),
		jobRef: null,
		jobSha: null,
	},
	run: {
		id: "100",
		attempt: 1,
		actor: "release-bot",
		actorId: "123",
		eventName: "workflow_dispatch",
		ref: "refs/heads/main",
		refType: "branch",
		commitSha: "a".repeat(40),
		environment: null,
		runnerEnvironment: "github-hosted",
	},
	issuedAt: 1_799_999_000,
	expiresAt: 1_800_000_000,
};
const RELEASE_INPUT = {
	release: {
		$type: NSID.packageRelease,
		package: "gallery",
		version: "1.2.3",
		artifacts: {
			package: {
				url: "https://example.com/gallery.tgz",
				checksum: "bciqcz4snxjp3biyoe3udwkwfxhrj4gywdzob7j2clzzqim3csofzqja",
			},
		},
		extensions: {
			[NSID.packageReleaseExtension]: {
				$type: NSID.packageReleaseExtension,
				declaredAccess: {},
				provenance: {
					url: "https://example.com/provenance.json",
					checksum: "bciqaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					predicateType: "https://slsa.dev/provenance/v1",
					sourceRepository: "https://github.com/emdash-cms/gallery",
					builderId:
						"https://github.com/emdash-cms/gallery/.github/workflows/release.yml@refs/heads/main",
				},
			},
		},
	},
};
const ACCESS_DIFF = {
	changes: [
		{
			kind: "operation-added",
			category: "network",
			operation: "request",
			path: ["network", "request"],
			escalation: true,
		},
	],
	escalation: true,
};

const EVIDENCE: ApprovalEvidence = {
	intentId: INTENT_ID,
	publisherDid: PUBLISHER_DID,
	packageSlug: "gallery",
	version: "1.2.3",
	verificationGeneration: 4,
	workloadIdentityDigest: "7u8b16-443AUWBwwI1uVQmsjeU_KTHiyKxjy4z04FlA",
	releaseInputDigest: "9bHOUQ7KoEcAlBHom7rb9MHmVn1b32woiveMIxZk-Hg",
	profileCid: PROFILE_CID,
	baselineReleaseCid: null,
	artifactChecksum: "bciqcz4snxjp3biyoe3udwkwfxhrj4gywdzob7j2clzzqim3csofzqja",
	provenanceChecksum: "bciqaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	declaredAccessDiffDigest: "LBGKX2dDy6Ht_ClZjUrp5tfSzuPg_Zw-sEykbB1biYc",
	verificationDigest: "D".repeat(43),
};

function bindings() {
	return {
		...TEST_BINDINGS,
		PUBLIC_ORIGIN: ORIGIN,
		OAUTH_REDIRECT_URIS: `["${ORIGIN}/oauth/callback"]`,
	};
}

function cookieValue(header: string): string {
	return header.split(";", 1)[0] ?? "";
}

async function sessionHeaders(approverDid: `did:${string}:${string}` = APPROVER_DID) {
	const session = await createApproverApplicationSession(env.APPROVER_DO, approverDid);
	const csrf = cookieValue(session.setCookieHeaders[1]).split("=", 2)[1] ?? "";
	return {
		cookie: session.setCookieHeaders.map(cookieValue).join("; "),
		origin: ORIGIN,
		"x-emdash-request": "1",
		"x-emdash-csrf": csrf,
	};
}

async function createAwaitingIntent(
	overrides: {
		workloadIdentityJson?: string;
		releaseInputJson?: string;
		accessDiffJson?: string;
	} = {},
) {
	const stub = env.PUBLISHER_DO.getByName(PUBLISHER_DID);
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
		workloadIdentityDigest: EVIDENCE.workloadIdentityDigest,
		workloadIdempotencyDigest: "I".repeat(43),
		idempotencyKey: "github-run-100-attempt-1",
		requestDigest: EVIDENCE.releaseInputDigest,
		workloadIdentityJson: overrides.workloadIdentityJson ?? JSON.stringify(WORKLOAD_IDENTITY),
		releaseInputJson: overrides.releaseInputJson ?? JSON.stringify(RELEASE_INPUT),
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
		workflowId: "workflow-approval-route",
		now: NOW + 2,
	});
	await stub.putVerificationStep({
		publisherDid: PUBLISHER_DID,
		intentId: INTENT_ID,
		name: "policy-decision",
		inputDigest: "H".repeat(43),
		resultJson: JSON.stringify({
			accessDiffJson: overrides.accessDiffJson ?? JSON.stringify(ACCESS_DIFF),
		}),
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

function profileValue(approvers: string[]) {
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

function approvalNetwork(state: { approvers: string[]; cid: string }) {
	return async (input: RequestInfo | URL): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		if (url.hostname === "publisher.example.com" && url.pathname === "/.well-known/did.json") {
			return Response.json({
				id: PUBLISHER_DID,
				verificationMethod: [
					{
						id: `${PUBLISHER_DID}#atproto`,
						type: "Multikey",
						controller: PUBLISHER_DID,
						publicKeyMultibase: "zDnaeeC67nTB5vVpkk4JhzBKcMpXzBQ6XrmihS6cd2wWBAmGK",
					},
				],
				service: [
					{
						id: "#atproto_pds",
						type: "AtprotoPersonalDataServer",
						serviceEndpoint: "https://pds.example",
					},
				],
			});
		}
		if (url.hostname === "cloudflare-dns.com") {
			return Response.json({
				Status: 0,
				Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: "93.184.216.34" }] : [],
			});
		}
		if (url.hostname === "pds.example" && url.pathname === "/xrpc/com.atproto.repo.getRecord") {
			return Response.json({
				uri: `at://${PUBLISHER_DID}/${NSID.packageProfile}/gallery`,
				cid: state.cid,
				value: profileValue(state.approvers),
			});
		}
		if (url.hostname === "pds.example" && url.pathname === "/xrpc/com.atproto.sync.getRecord") {
			const bytes = Uint8Array.from(atob(PROFILE_PROOF), (character) => character.charCodeAt(0));
			return new Response(bytes, {
				headers: { "content-type": "application/vnd.ipld.car" },
			});
		}
		throw new Error(`Unexpected request: ${url.toString()}`);
	};
}

function createCredential() {
	const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const jwk = publicKey.export({ format: "jwk" });
	if (typeof jwk.x !== "string" || typeof jwk.y !== "string") {
		throw new Error("Failed to export public key");
	}
	return {
		privateKey,
		publicKey: new Uint8Array(
			Buffer.concat([
				Buffer.from([0x04]),
				Buffer.from(jwk.x, "base64url"),
				Buffer.from(jwk.y, "base64url"),
			]),
		),
	};
}

function assertion(
	privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
	challenge: string,
	userVerified = true,
) {
	const clientDataJSON = Buffer.from(
		JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN }),
	);
	const rpIdHash = createHash("sha256").update("release.example.com").digest();
	const counter = Buffer.alloc(4);
	counter.writeUInt32BE(1);
	const authenticatorData = Buffer.concat([
		rpIdHash,
		Buffer.from([userVerified ? 0x05 : 0x01]),
		counter,
	]);
	const signature = sign(
		"sha256",
		Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]),
		privateKey,
	);
	return {
		id: CREDENTIAL_ID,
		rawId: CREDENTIAL_ID,
		type: "public-key",
		response: {
			clientDataJSON: clientDataJSON.toString("base64url"),
			authenticatorData: authenticatorData.toString("base64url"),
			signature: signature.toString("base64url"),
		},
	};
}

async function enrolCredential(approverDid: `did:${string}:${string}` = APPROVER_DID) {
	const key = createCredential();
	await env.APPROVER_DO.getByName(approverDid).enrolCredential(approverDid, {
		credentialId: CREDENTIAL_ID,
		publicKey: key.publicKey,
		algorithm: -7,
		counter: 0,
		transports: ["internal"],
		name: "Laptop",
	});
	return key;
}

afterEach(async () => {
	vi.unstubAllGlobals();
	await reset();
});

describe("approval decision routes", () => {
	it("reads current evidence, verifies a passkey, and transitions the publisher intent", async () => {
		await createAwaitingIntent();
		const key = await enrolCredential();
		const network = { approvers: [APPROVER_DID], cid: PROFILE_CID };
		vi.stubGlobal("fetch", approvalNetwork(network));
		const headers = await sessionHeaders();
		const resource = `${ORIGIN}/v1/approvals/${INTENT_ID}?publisher=${encodeURIComponent(PUBLISHER_DID)}`;

		const detail = await handleRequest(new Request(resource, { headers }), bindings());
		expect(detail.status, await detail.clone().text()).toBe(200);
		await expect(detail.json()).resolves.toMatchObject({
			data: {
				intent: { state: "awaiting_approval", packageSlug: "gallery", version: "1.2.3" },
				evidence: { profileCid: PROFILE_CID },
				review: {
					source: {
						repository: "emdash-cms/gallery",
						commitSha: "a".repeat(40),
					},
					artifact: { checksum: EVIDENCE.artifactChecksum },
					provenance: { checksum: EVIDENCE.provenanceChecksum },
					accessDiff: {
						escalation: true,
						changes: [{ category: "network", operation: "request" }],
					},
				},
			},
		});

		const optionsResponse = await handleRequest(
			new Request(resource.replace(`?`, `/options?`), {
				method: "POST",
				headers: { ...headers, "content-type": "application/json" },
				body: JSON.stringify({ decision: "approve" }),
			}),
			bindings(),
		);
		expect(optionsResponse.status).toBe(200);
		const optionsBody = await optionsResponse.json<{
			data: { challenge: string; userVerification: string };
		}>();
		expect(optionsBody.data.userVerification).toBe("required");

		const decisionBody = {
			decision: "approve",
			idempotencyKey: "approval-route-idempotency-0001",
			response: assertion(key.privateKey, optionsBody.data.challenge),
		};
		const decided = await handleRequest(
			new Request(resource, {
				method: "POST",
				headers: { ...headers, "content-type": "application/json" },
				body: JSON.stringify(decisionBody),
			}),
			bindings(),
		);
		expect(decided.status).toBe(200);
		await expect(decided.json()).resolves.toMatchObject({
			data: {
				receipt: { decision: "approve", approverDid: APPROVER_DID },
				intent: { state: "ready" },
			},
		});
		await env.PUBLISHER_DO.getByName(PUBLISHER_DID).transitionIntent({
			publisherDid: PUBLISHER_DID,
			intentId: INTENT_ID,
			expectedState: "ready",
			expectedGeneration: 5,
			toState: "publishing",
			transitionDigest: "H".repeat(43),
			actorRealm: "system",
			actorIdentity: "release-service",
			reasonCode: null,
			stateDataJson: "{}",
		});

		const replayed = await handleRequest(
			new Request(resource, {
				method: "POST",
				headers: { ...headers, "content-type": "application/json" },
				body: JSON.stringify(decisionBody),
			}),
			bindings(),
		);
		expect(replayed.status).toBe(200);
		await expect(
			env.PUBLISHER_DO.getByName(PUBLISHER_DID).getIntent(PUBLISHER_DID, INTENT_ID),
		).resolves.toMatchObject({
			state: "publishing",
			stateGeneration: 6,
		});
	});

	it.each([
		[
			"workload identity",
			{
				workloadIdentityJson: JSON.stringify({
					...WORKLOAD_IDENTITY,
					repository: { ...WORKLOAD_IDENTITY.repository, name: "attacker/gallery" },
				}),
			},
		],
		[
			"release input",
			{
				releaseInputJson: JSON.stringify({
					release: {
						...RELEASE_INPUT.release,
						artifacts: {
							package: {
								...RELEASE_INPUT.release.artifacts.package,
								checksum: EVIDENCE.provenanceChecksum,
							},
						},
					},
				}),
			},
		],
		[
			"declared access diff",
			{
				accessDiffJson: JSON.stringify({
					...ACCESS_DIFF,
					changes: [{ ...ACCESS_DIFF.changes[0], category: "storage" }],
				}),
			},
		],
	] as const)(
		"fails closed when stored %s diverges from approval evidence",
		async (_, overrides) => {
			await createAwaitingIntent(overrides);
			vi.stubGlobal("fetch", approvalNetwork({ approvers: [APPROVER_DID], cid: PROFILE_CID }));
			const resource = `${ORIGIN}/v1/approvals/${INTENT_ID}?publisher=${encodeURIComponent(PUBLISHER_DID)}`;
			const response = await handleRequest(
				new Request(resource, { headers: await sessionHeaders() }),
				bindings(),
			);

			expect(response.status).toBe(404);
			await expect(response.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } });
		},
	);

	it("ignores an unsigned profile envelope that omits an immutable approver", async () => {
		await createAwaitingIntent();
		await enrolCredential();
		vi.stubGlobal("fetch", approvalNetwork({ approvers: ["did:plc:other"], cid: PROFILE_CID }));
		const resource = `${ORIGIN}/v1/approvals/${INTENT_ID}/options?publisher=${encodeURIComponent(PUBLISHER_DID)}`;
		const response = await handleRequest(
			new Request(resource, {
				method: "POST",
				headers: { ...(await sessionHeaders()), "content-type": "application/json" },
				body: JSON.stringify({ decision: "approve" }),
			}),
			bindings(),
		);
		expect(response.status).toBe(200);
	});

	it("rejects an attacker passkey even when an unsigned profile envelope substitutes their DID", async () => {
		await createAwaitingIntent();
		await enrolCredential(ATTACKER_DID);
		vi.stubGlobal("fetch", approvalNetwork({ approvers: [ATTACKER_DID], cid: PROFILE_CID }));
		const resource = `${ORIGIN}/v1/approvals/${INTENT_ID}/options?publisher=${encodeURIComponent(PUBLISHER_DID)}`;
		const response = await handleRequest(
			new Request(resource, {
				method: "POST",
				headers: {
					...(await sessionHeaders(ATTACKER_DID)),
					"content-type": "application/json",
				},
				body: JSON.stringify({ decision: "approve" }),
			}),
			bindings(),
		);

		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } });
		await expect(
			env.PUBLISHER_DO.getByName(PUBLISHER_DID).getIntent(PUBLISHER_DID, INTENT_ID),
		).resolves.toMatchObject({ state: "awaiting_approval" });
	});

	it("rejects non-user-verified assertions without transitioning", async () => {
		await createAwaitingIntent();
		const key = await enrolCredential();
		const network = { approvers: [APPROVER_DID], cid: PROFILE_CID };
		vi.stubGlobal("fetch", approvalNetwork(network));
		const headers = await sessionHeaders();
		const optionsUrl = `${ORIGIN}/v1/approvals/${INTENT_ID}/options?publisher=${encodeURIComponent(PUBLISHER_DID)}`;
		const optionsResponse = await handleRequest(
			new Request(optionsUrl, {
				method: "POST",
				headers: { ...headers, "content-type": "application/json" },
				body: JSON.stringify({ decision: "approve" }),
			}),
			bindings(),
		);
		const optionsBody = await optionsResponse.json<{ data: { challenge: string } }>();
		const resource = `${ORIGIN}/v1/approvals/${INTENT_ID}?publisher=${encodeURIComponent(PUBLISHER_DID)}`;
		const nonUv = await handleRequest(
			new Request(resource, {
				method: "POST",
				headers: { ...headers, "content-type": "application/json" },
				body: JSON.stringify({
					decision: "approve",
					idempotencyKey: "approval-route-idempotency-0001",
					response: assertion(key.privateKey, optionsBody.data.challenge, false),
				}),
			}),
			bindings(),
		);
		expect(nonUv.status).toBe(400);

		await expect(
			env.PUBLISHER_DO.getByName(PUBLISHER_DID).getIntent(PUBLISHER_DID, INTENT_ID),
		).resolves.toMatchObject({
			state: "awaiting_approval",
		});
	});
});

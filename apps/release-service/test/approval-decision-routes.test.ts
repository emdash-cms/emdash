import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { NSID } from "@emdash-cms/registry-lexicons";
import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { encodeAwaitingApprovalState, type ApprovalEvidence } from "../src/approvals/digest.js";
import { createApproverApplicationSession } from "../src/approver-session/session.js";
import { handleRequest } from "../src/index.js";
import { TEST_BINDINGS } from "./fixtures/oauth.js";

const ORIGIN = "https://release.example.invalid";
const PUBLISHER_DID = "did:web:publisher.example.com";
const APPROVER_DID = "did:plc:approver";
const INTENT_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const CREDENTIAL_ID = "approval-credential";
const PROFILE_CID = "bafyreib3p6qexampleprofilecid";
const NOW = 1_800_000_000_000;

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

async function sessionHeaders() {
	const session = await createApproverApplicationSession(env.APPROVER_DO, APPROVER_DID);
	const csrf = cookieValue(session.setCookieHeaders[1]).split("=", 2)[1] ?? "";
	return {
		cookie: session.setCookieHeaders.map(cookieValue).join("; "),
		origin: ORIGIN,
		"x-emdash-request": "1",
		"x-emdash-csrf": csrf,
	};
}

async function createAwaitingIntent() {
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
		workloadIdentityDigest: "A".repeat(43),
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
		workflowId: "workflow-approval-route",
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
		stateDataJson: await encodeAwaitingApprovalState(EVIDENCE),
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
	const rpIdHash = createHash("sha256").update("release.example.invalid").digest();
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

async function enrolCredential() {
	const key = createCredential();
	await env.APPROVER_DO.getByName(APPROVER_DID).enrolCredential(APPROVER_DID, {
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
		expect(detail.status).toBe(200);
		await expect(detail.json()).resolves.toMatchObject({
			data: {
				intent: { state: "awaiting_approval", packageSlug: "gallery", version: "1.2.3" },
				evidence: { profileCid: PROFILE_CID },
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

	it("rejects an unlisted approver before creating a challenge", async () => {
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
		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } });
	});

	it("rejects profile changes and non-user-verified assertions without transitioning", async () => {
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

		network.cid = "bafyreib3p6qchangedprofilecid";
		const changed = await handleRequest(
			new Request(optionsUrl, {
				method: "POST",
				headers: { ...headers, "content-type": "application/json" },
				body: JSON.stringify({ decision: "approve" }),
			}),
			bindings(),
		);
		expect(changed.status).toBe(409);
		await expect(changed.json()).resolves.toMatchObject({ error: { code: "PROFILE_CHANGED" } });
		await expect(
			env.PUBLISHER_DO.getByName(PUBLISHER_DID).getIntent(PUBLISHER_DID, INTENT_ID),
		).resolves.toMatchObject({
			state: "awaiting_approval",
		});
	});
});

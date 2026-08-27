import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import {
	ApprovalPasskeyError,
	beginApprovalDecision,
	beginApproverCredentialRegistration,
	completeApprovalDecision,
	type ApprovalDecisionRequest,
} from "../src/approvals/passkeys.js";

const APPROVER_DID = "did:plc:approver";
const PUBLISHER_DID = "did:plc:publisher";
const INTENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const EVIDENCE_DIGEST = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CREDENTIAL_ID = "approval-credential";
const RELYING_PARTY = {
	rpId: "release.example.com",
	origin: "https://release.example.com",
} as const;

const REQUEST: ApprovalDecisionRequest = {
	approverDid: APPROVER_DID,
	publisherDid: PUBLISHER_DID,
	intentId: INTENT_ID,
	evidenceDigest: EVIDENCE_DIGEST,
	decision: "approve",
};

function approver() {
	return env.APPROVER_DO.getByName(APPROVER_DID);
}

function createCredential() {
	const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const jwk = publicKey.export({ format: "jwk" });
	if (typeof jwk.x !== "string" || typeof jwk.y !== "string") {
		throw new Error("Failed to export test public key");
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

function createAssertion(
	privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
	challenge: string,
	options: { counter?: number; origin?: string; userVerified?: boolean } = {},
) {
	const origin = options.origin ?? RELYING_PARTY.origin;
	const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin }));
	const rpIdHash = createHash("sha256").update(RELYING_PARTY.rpId).digest();
	const signatureCounter = Buffer.alloc(4);
	signatureCounter.writeUInt32BE(options.counter ?? 1);
	const flags = options.userVerified === false ? 0x01 : 0x05;
	const authenticatorData = Buffer.concat([rpIdHash, Buffer.from([flags]), signatureCounter]);
	const signature = sign(
		"sha256",
		Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]),
		privateKey,
	);
	return {
		id: CREDENTIAL_ID,
		rawId: CREDENTIAL_ID,
		type: "public-key" as const,
		response: {
			clientDataJSON: clientDataJSON.toString("base64url"),
			authenticatorData: authenticatorData.toString("base64url"),
			signature: signature.toString("base64url"),
		},
	};
}

async function enrolCredential() {
	const key = createCredential();
	await approver().enrolCredential(APPROVER_DID, {
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
	await reset();
});

describe("approval passkey ceremonies", () => {
	it("requires user verification for registration and binds the credential name", async () => {
		const options = await beginApproverCredentialRegistration(
			approver(),
			APPROVER_DID,
			"Laptop",
			RELYING_PARTY,
		);

		expect(options.authenticatorSelection?.userVerification).toBe("required");
		expect(options.rp).toEqual({ id: RELYING_PARTY.rpId, name: "EmDash release approvals" });
		expect(options.user.name).toBe(APPROVER_DID);
	});

	it("records an exact digest-bound, user-verified decision and replays its receipt", async () => {
		const key = await enrolCredential();
		const begun = await beginApprovalDecision(approver(), REQUEST, RELYING_PARTY);
		expect(begun.options.userVerification).toBe("required");
		expect(begun.options.allowCredentials).toEqual([
			{ type: "public-key", id: CREDENTIAL_ID, transports: ["internal"] },
		]);

		const response = createAssertion(key.privateKey, begun.options.challenge);
		const first = await completeApprovalDecision(
			approver(),
			REQUEST,
			"approval-idempotency-0001",
			response,
			RELYING_PARTY,
			1_800_000_000_000,
		);
		expect(first).toMatchObject({
			ok: true,
			replayed: false,
			receipt: {
				approverDid: APPROVER_DID,
				publisherDid: PUBLISHER_DID,
				intentId: INTENT_ID,
				decision: "approve",
				credentialId: CREDENTIAL_ID,
			},
		});
		const second = await completeApprovalDecision(
			approver(),
			REQUEST,
			"approval-idempotency-0001",
			response,
			RELYING_PARTY,
			1_800_000_000_001,
		);
		expect(second).toEqual(
			first.ok ? { ...first, replayed: true } : expect.objectContaining({ ok: true }),
		);
		await expect(
			approver().getCredentialForVerification(APPROVER_DID, CREDENTIAL_ID),
		).resolves.toMatchObject({ counter: 1 });
	});

	it("rejects an assertion without user verification", async () => {
		const key = await enrolCredential();
		const begun = await beginApprovalDecision(approver(), REQUEST, RELYING_PARTY);
		const response = createAssertion(key.privateKey, begun.options.challenge, {
			userVerified: false,
		});

		await expect(
			completeApprovalDecision(
				approver(),
				REQUEST,
				"approval-idempotency-0001",
				response,
				RELYING_PARTY,
			),
		).rejects.toMatchObject({ code: "APPROVER_CHALLENGE_INVALID" });
		await expect(
			approver().getDecision(APPROVER_DID, INTENT_ID, begun.context.approvalDigest),
		).resolves.toBeNull();
	});

	it("rejects decision, origin, and RP substitutions", async () => {
		const key = await enrolCredential();
		const decisionBound = await beginApprovalDecision(approver(), REQUEST, RELYING_PARTY);
		await expect(
			completeApprovalDecision(
				approver(),
				{ ...REQUEST, decision: "reject" },
				"approval-idempotency-0001",
				createAssertion(key.privateKey, decisionBound.options.challenge),
				RELYING_PARTY,
			),
		).rejects.toMatchObject({ code: "APPROVER_CHALLENGE_INVALID" });

		const originBound = await beginApprovalDecision(approver(), REQUEST, RELYING_PARTY);
		await expect(
			completeApprovalDecision(
				approver(),
				REQUEST,
				"approval-idempotency-0002",
				createAssertion(key.privateKey, originBound.options.challenge, {
					origin: "https://attacker.example",
				}),
				RELYING_PARTY,
			),
		).rejects.toMatchObject({ code: "APPROVER_CHALLENGE_INVALID" });

		await expect(
			beginApprovalDecision(approver(), REQUEST, {
				rpId: "other.example.invalid",
				origin: RELYING_PARTY.origin,
			}),
		).rejects.toBeInstanceOf(ApprovalPasskeyError);
	});

	it("fails closed when a credential is revoked after challenge creation", async () => {
		const key = await enrolCredential();
		const begun = await beginApprovalDecision(approver(), REQUEST, RELYING_PARTY);
		await approver().revokeCredential(APPROVER_DID, CREDENTIAL_ID);

		await expect(
			completeApprovalDecision(
				approver(),
				REQUEST,
				"approval-idempotency-0001",
				createAssertion(key.privateKey, begun.options.challenge),
				RELYING_PARTY,
			),
		).resolves.toEqual({ ok: false, code: "CREDENTIAL_NOT_FOUND" });
	});
});

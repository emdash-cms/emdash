import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { createAssertionSignatureMessage } from "@oslojs/webauthn";
import { describe, it, expect, vi } from "vitest";

import type { AuthAdapter, Credential } from "../types.js";
import { authenticateWithPasskey, PasskeyAuthenticationError } from "./authenticate.js";
import type { ChallengeStore } from "./types.js";

const credential: Credential = {
	id: "registered-credential",
	userId: "user_1",
	publicKey: new Uint8Array(),
	counter: 0,
	deviceType: "singleDevice",
	backedUp: false,
	transports: [],
	name: null,
	createdAt: new Date(),
	lastUsedAt: new Date(),
};

const config = {
	rpName: "Test Site",
	rpId: "localhost",
	origin: "http://localhost:4321",
};

function createAdapter(): AuthAdapter {
	return {
		getCredentialById: vi.fn(async () => credential),
		updateCredentialCounter: vi.fn(async () => undefined),
		getUserById: vi.fn(async () => null),
	} as unknown as AuthAdapter;
}

function createChallengeStore(): ChallengeStore {
	return {
		set: vi.fn(async () => undefined),
		get: vi.fn(async () => null),
		delete: vi.fn(async () => undefined),
	};
}

function base64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

function createValidAssertion() {
	const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const jwk = publicKey.export({ format: "jwk" });
	if (typeof jwk.x !== "string" || typeof jwk.y !== "string") {
		throw new Error("Failed to export test public key");
	}

	const publicKeyBytes = Buffer.concat([
		Buffer.from([0x04]),
		Buffer.from(jwk.x, "base64url"),
		Buffer.from(jwk.y, "base64url"),
	]);
	const challenge = base64url(Buffer.from("test-challenge"));
	const clientDataJSON = Buffer.from(
		JSON.stringify({
			type: "webauthn.get",
			challenge,
			origin: config.origin,
		}),
	);
	const rpIdHash = createHash("sha256").update(config.rpId).digest();
	const signatureCounter = Buffer.alloc(4);
	signatureCounter.writeUInt32BE(1);
	const authenticatorData = Buffer.concat([rpIdHash, Buffer.from([0x01]), signatureCounter]);
	const signatureMessage = createAssertionSignatureMessage(authenticatorData, clientDataJSON);
	const signatureBytes = sign("sha256", signatureMessage, privateKey);

	return {
		credential: {
			...credential,
			publicKey: new Uint8Array(publicKeyBytes),
		},
		response: {
			id: credential.id,
			rawId: credential.id,
			type: "public-key" as const,
			response: {
				clientDataJSON: base64url(clientDataJSON),
				authenticatorData: base64url(authenticatorData),
				signature: base64url(signatureBytes),
			},
		},
		challengeStore: {
			set: vi.fn(async () => undefined),
			get: vi.fn(async () => ({ type: "authentication" as const, expiresAt: Date.now() + 60_000 })),
			delete: vi.fn(async () => undefined),
		} satisfies ChallengeStore,
	};
}

describe("authenticateWithPasskey", () => {
	it("throws a typed passkey auth error for malformed assertion payloads", async () => {
		try {
			await authenticateWithPasskey(
				config,
				createAdapter(),
				{
					id: "registered-credential",
					rawId: "registered-credential",
					type: "public-key",
					response: {
						clientDataJSON: "AA",
						authenticatorData: "AA",
						signature: "AA",
					},
				},
				createChallengeStore(),
			);
			expect.fail("Expected passkey authentication to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(PasskeyAuthenticationError);
			expect(error).toMatchObject({ code: "invalid_response" });
		}
	});

	it("throws a typed passkey auth error when a credential has no user", async () => {
		const { credential: validCredential, response, challengeStore } = createValidAssertion();
		const adapter = {
			getCredentialById: vi.fn(async () => validCredential),
			updateCredentialCounter: vi.fn(async () => undefined),
			getUserById: vi.fn(async () => null),
		} as unknown as AuthAdapter;

		try {
			await authenticateWithPasskey(config, adapter, response, challengeStore);
			expect.fail("Expected passkey authentication to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(PasskeyAuthenticationError);
			expect(error).toMatchObject({ code: "user_not_found" });
		}
	});
});

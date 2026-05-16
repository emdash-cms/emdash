import { createHash, generateKeyPairSync, sign } from "node:crypto";

import {
	createAssertionSignatureMessage,
	coseAlgorithmES256,
	coseAlgorithmRS256,
} from "@oslojs/webauthn";
import { describe, it, expect, vi } from "vitest";

import type { AuthAdapter, Credential } from "../types.js";
import { authenticateWithPasskey, PasskeyAuthenticationError } from "./authenticate.js";
import type { ChallengeStore } from "./types.js";

const credential: Credential = {
	id: "registered-credential",
	userId: "user_1",
	publicKey: new Uint8Array(),
	algorithm: coseAlgorithmES256,
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
	origins: ["http://localhost:4321"],
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

function createValidAssertion(opts: { rpId?: string; origin?: string } = {}) {
	const rpId = opts.rpId ?? config.rpId;
	const origin = opts.origin ?? config.origins[0];
	if (!origin) throw new Error("origin must be defined for createValidAssertion");
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
			origin,
		}),
	);
	const rpIdHash = createHash("sha256").update(rpId).digest();
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

function createValidRS256Assertion(opts: { rpId?: string; origin?: string } = {}) {
	const rpId = opts.rpId ?? config.rpId;
	const origin = opts.origin ?? config.origins[0];
	if (!origin) throw new Error("origin must be defined for createValidRS256Assertion");

	// Generate RSA key pair
	const { privateKey, publicKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
	});

	// Export public key in PKIX (SPKI) format - this is what we store for RSA
	const publicKeyBytes = publicKey.export({ type: "spki", format: "der" });

	const challenge = base64url(Buffer.from("test-challenge"));
	const clientDataJSON = Buffer.from(
		JSON.stringify({
			type: "webauthn.get",
			challenge,
			origin,
		}),
	);

	const rpIdHash = createHash("sha256").update(rpId).digest();
	const signatureCounter = Buffer.alloc(4);
	signatureCounter.writeUInt32BE(1);
	const authenticatorData = Buffer.concat([rpIdHash, Buffer.from([0x01]), signatureCounter]);
	const signatureMessage = createAssertionSignatureMessage(authenticatorData, clientDataJSON);

	// RSA signatures in WebAuthn use RSASSA-PKCS1-v1_5 + SHA-256
	const signatureBytes = sign("sha256", signatureMessage, privateKey);

	return {
		credential: {
			...credential,
			algorithm: coseAlgorithmRS256,
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

	it("rejects an origin that is not in the accepted list", async () => {
		// Single-origin config; assertion arrives from a different subdomain.
		const singleOriginConfig = {
			rpName: "Test Site",
			rpId: "example.com",
			origins: ["https://example.com"],
		};
		const {
			credential: validCredential,
			response,
			challengeStore,
		} = createValidAssertion({
			rpId: "example.com",
			origin: "https://preview.example.com",
		});
		const adapter = {
			getCredentialById: vi.fn(async () => validCredential),
			updateCredentialCounter: vi.fn(async () => undefined),
			getUserById: vi.fn(async () => ({ id: "user_1" })),
		} as unknown as AuthAdapter;

		try {
			await authenticateWithPasskey(singleOriginConfig, adapter, response, challengeStore);
			expect.fail("Expected origin rejection");
		} catch (error) {
			expect(error).toBeInstanceOf(PasskeyAuthenticationError);
			expect(error).toMatchObject({ code: "invalid_origin" });
			expect((error as PasskeyAuthenticationError).message).toContain(
				"https://preview.example.com",
			);
		}
	});

	it("accepts an assertion from a subdomain when its origin is listed under a shared rpId", async () => {
		// Reproduces emdash-cms/emdash#393 follow-up: apex + preview share rpId,
		// passkey was bound to the apex but the user is hitting preview.
		const multiOriginConfig = {
			rpName: "Test Site",
			rpId: "example.com",
			origins: ["https://example.com", "https://preview.example.com"],
		};
		const {
			credential: validCredential,
			response,
			challengeStore,
		} = createValidAssertion({
			rpId: "example.com",
			origin: "https://preview.example.com",
		});
		const adapter = {
			getCredentialById: vi.fn(async () => validCredential),
			updateCredentialCounter: vi.fn(async () => undefined),
			getUserById: vi.fn(async () => ({
				id: "user_1",
				email: "u@example.com",
				name: null,
				role: "admin",
			})),
		} as unknown as AuthAdapter;

		// Should not throw — origin is in the accepted list.
		const user = await authenticateWithPasskey(
			multiOriginConfig,
			adapter,
			response,
			challengeStore,
		);
		expect(user).toMatchObject({ id: "user_1" });
	});

	it("accepts an RS256 (RSA) assertion with a PKIX-encoded public key", async () => {
		const { credential: rsaCredential, response, challengeStore } = createValidRS256Assertion();
		const adapter = {
			getCredentialById: vi.fn(async () => rsaCredential),
			updateCredentialCounter: vi.fn(async () => undefined),
			getUserById: vi.fn(async () => ({ id: "user_1" })),
		} as unknown as AuthAdapter;

		const user = await authenticateWithPasskey(config, adapter, response, challengeStore);
		expect(user).toMatchObject({ id: "user_1" });
	});

	it("throws a typed error for an unsupported algorithm", async () => {
		const { credential: validCredential, response, challengeStore } = createValidAssertion();
		const adapter = {
			getCredentialById: vi.fn(async () => ({
				...validCredential,
				algorithm: 0, // Unsupported algorithm ID
			})),
			updateCredentialCounter: vi.fn(async () => undefined),
			getUserById: vi.fn(async () => ({ id: "user_1" })),
		} as unknown as AuthAdapter;

		try {
			await authenticateWithPasskey(config, adapter, response, challengeStore);
			expect.fail("Expected algorithm rejection");
		} catch (error) {
			expect(error).toBeInstanceOf(PasskeyAuthenticationError);
			expect(error).toMatchObject({
				code: "unsupported_algorithm",
				message: "Unsupported credential algorithm: 0",
			});
		}
	});
});

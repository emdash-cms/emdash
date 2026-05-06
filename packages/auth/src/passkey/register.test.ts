import { generateKeyPairSync } from "node:crypto";

import { decodePKIXRSAPublicKey } from "@oslojs/crypto/rsa";
import { encodeBase64urlNoPadding } from "@oslojs/encoding";
import { parseAttestationObject, coseAlgorithmRS256, COSEKeyType } from "@oslojs/webauthn";
import { describe, expect, it, vi } from "vitest";

import { verifyRegistrationResponse } from "./register.js";
import type { ChallengeStore, PasskeyConfig } from "./types.js";

/**
 * Locks in origin-check parity with `authenticate.ts`. The two functions
 * share the same 3-line block; without this test, a divergence would slip
 * through. The challenge mock satisfies the prior steps so origin verification
 * is the next gate the function reaches — `attestationObject` is junk, which
 * never gets parsed because the origin check fires first.
 */

const config: PasskeyConfig = {
	rpName: "Test Site",
	rpId: "example.com",
	origins: ["https://example.com"],
};

function base64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

function makeChallengeStore(): ChallengeStore {
	return {
		set: vi.fn(async () => undefined),
		get: vi.fn(async () => ({
			type: "registration" as const,
			userId: "user_1",
			expiresAt: Date.now() + 60_000,
		})),
		delete: vi.fn(async () => undefined),
	};
}

vi.mock("@oslojs/webauthn", async (importOriginal) => {
	const mod = await importOriginal<typeof import("@oslojs/webauthn")>();
	return {
		...mod,
		parseAttestationObject: vi.fn(mod.parseAttestationObject),
	};
});

describe("verifyRegistrationResponse", () => {
	it("rejects an origin not in the accepted list", async () => {
		const challenge = encodeBase64urlNoPadding(new TextEncoder().encode("test-challenge"));
		const clientDataJSON = Buffer.from(
			JSON.stringify({
				type: "webauthn.create",
				challenge,
				origin: "https://attacker.com",
			}),
		);

		await expect(
			verifyRegistrationResponse(
				config,
				{
					id: "test-credential",
					rawId: "test-credential",
					type: "public-key",
					response: {
						clientDataJSON: base64url(clientDataJSON),
						attestationObject: "AA",
					},
				},
				makeChallengeStore(),
			),
		).rejects.toThrow(/Invalid origin: https:\/\/attacker\.com not in/);
	});

	it("processes an RS256 registration correctly and encodes to PKIX", async () => {
		const challenge = encodeBase64urlNoPadding(new TextEncoder().encode("test-challenge"));
		const clientDataJSON = Buffer.from(
			JSON.stringify({
				type: "webauthn.create",
				challenge,
				origin: "https://example.com",
			}),
		);

		// Generate a real RSA key pair to get valid modulus and exponent
		const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
		const jwk = publicKey.export({ format: "jwk" });
		const nBuf = Buffer.from(jwk.n!, "base64url");
		const eBuf = Buffer.from(jwk.e!, "base64url");

		// oslojs expects these to be BigInts for its internal math
		const n = BigInt("0x" + nBuf.toString("hex"));
		const e = BigInt("0x" + eBuf.toString("hex"));

		// Mock the parsed attestation object to bypass CBOR parsing and inject our RSA key
		vi.mocked(parseAttestationObject).mockReturnValueOnce({
			authenticatorData: {
				rpIdHash: new Uint8Array(32),
				verifyRelyingPartyIdHash: () => true,
				userPresent: true,
				userVerified: true,
				flags: { uv: true, up: true, be: false, bs: false, at: true, ed: false },
				signatureCounter: 0,
				credential: {
					id: new Uint8Array(16),
					publicKey: {
						algorithm: () => coseAlgorithmRS256,
						type: () => COSEKeyType.RSA,
						rsa: () => ({ n, e }),
					},
				},
			},
			attestationStatement: {
				format: "none",
			},
		} as any);

		const result = await verifyRegistrationResponse(
			config,
			{
				id: "test-credential",
				rawId: "test-credential",
				type: "public-key",
				response: {
					clientDataJSON: base64url(clientDataJSON),
					attestationObject: "AA", // Mocked
				},
			},
			makeChallengeStore(),
		);

		expect(result.algorithm).toBe(coseAlgorithmRS256);
		expect(result.publicKey).toBeInstanceOf(Uint8Array);

		// Verify the round-trip: encodePKIX() was called, so decodePKIXRSAPublicKey() should work
		const decoded = decodePKIXRSAPublicKey(result.publicKey);
		expect(decoded.n).toEqual(n);
		expect(decoded.e).toEqual(e);
	});
});

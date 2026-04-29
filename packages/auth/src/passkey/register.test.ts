import { encodeBase64urlNoPadding } from "@oslojs/encoding";
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
});

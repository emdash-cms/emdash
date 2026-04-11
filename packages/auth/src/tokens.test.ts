import { describe, it, expect } from "vitest";

import {
	generateToken,
	hashToken,
	generateTokenWithHash,
	generateSessionId,
	generateAuthSecret,
	secureCompare,
	computeS256Challenge,
	encrypt,
	decrypt,
	encryptWithHKDF,
	decryptWithHKDF,
} from "./tokens.js";

const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;
const NO_PADDING_REGEX = /^[A-Za-z0-9_-]+$/;

describe("tokens", () => {
	describe("generateToken", () => {
		it("generates a base64url-encoded token", () => {
			const token = generateToken();
			expect(token).toMatch(BASE64URL_REGEX);
			// 32 bytes = 43 base64url characters (without padding)
			expect(token.length).toBe(43);
		});

		it("generates unique tokens", () => {
			// eslint-disable-next-line e18e/prefer-array-fill -- We need unique tokens, not the same token repeated
			const tokens = new Set(Array.from({ length: 100 }, () => generateToken()));
			expect(tokens.size).toBe(100);
		});
	});

	describe("hashToken", () => {
		it("produces consistent hashes", () => {
			const token = generateToken();
			const hash1 = hashToken(token);
			const hash2 = hashToken(token);
			expect(hash1).toBe(hash2);
		});

		it("produces different hashes for different tokens", () => {
			const token1 = generateToken();
			const token2 = generateToken();
			expect(hashToken(token1)).not.toBe(hashToken(token2));
		});
	});

	describe("generateTokenWithHash", () => {
		it("returns both token and hash", () => {
			const { token, hash } = generateTokenWithHash();
			expect(token).toBeDefined();
			expect(hash).toBeDefined();
			expect(hashToken(token)).toBe(hash);
		});
	});

	describe("generateSessionId", () => {
		it("generates a shorter session ID", () => {
			const sessionId = generateSessionId();
			expect(sessionId).toMatch(BASE64URL_REGEX);
			// 20 bytes = 27 base64url characters
			expect(sessionId.length).toBe(27);
		});
	});

	describe("generateAuthSecret", () => {
		it("generates a 32-byte secret", () => {
			const secret = generateAuthSecret();
			expect(secret).toMatch(BASE64URL_REGEX);
			expect(secret.length).toBe(43);
		});
	});

	describe("secureCompare", () => {
		it("returns true for equal strings", () => {
			expect(secureCompare("hello", "hello")).toBe(true);
		});

		it("returns false for different strings", () => {
			expect(secureCompare("hello", "world")).toBe(false);
		});

		it("returns false for different length strings", () => {
			expect(secureCompare("hello", "hello!")).toBe(false);
		});
	});

	describe("computeS256Challenge", () => {
		it("produces correct S256 challenge for a known verifier", () => {
			// RFC 7636 Appendix B test vector:
			// verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
			// expected challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
			const challenge = computeS256Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
			expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
		});

		it("produces base64url output without padding", () => {
			const challenge = computeS256Challenge("test-verifier-string");
			expect(challenge).toMatch(NO_PADDING_REGEX);
			expect(challenge).not.toContain("=");
		});

		it("is deterministic", () => {
			const a = computeS256Challenge("same-input");
			const b = computeS256Challenge("same-input");
			expect(a).toBe(b);
		});

		it("produces different output for different input", () => {
			const a = computeS256Challenge("verifier-one");
			const b = computeS256Challenge("verifier-two");
			expect(a).not.toBe(b);
		});
	});

	describe("encrypt/decrypt", () => {
		const secret = generateAuthSecret();

		it("encrypts and decrypts a string", async () => {
			const plaintext = "my-secret-value";
			const encrypted = await encrypt(plaintext, secret);
			const decrypted = await decrypt(encrypted, secret);
			expect(decrypted).toBe(plaintext);
		});

		it("produces different ciphertext each time (due to random IV)", async () => {
			const plaintext = "my-secret-value";
			const encrypted1 = await encrypt(plaintext, secret);
			const encrypted2 = await encrypt(plaintext, secret);
			expect(encrypted1).not.toBe(encrypted2);
		});

		it("fails to decrypt with wrong secret", async () => {
			const plaintext = "my-secret-value";
			const encrypted = await encrypt(plaintext, secret);
			const wrongSecret = generateAuthSecret();
			await expect(decrypt(encrypted, wrongSecret)).rejects.toThrow();
		});
	});

	describe("encryptWithHKDF/decryptWithHKDF", () => {
		const secret = generateAuthSecret();

		it("round-trips a string", async () => {
			const plaintext = "totp-secret-bytes";
			const encrypted = await encryptWithHKDF(plaintext, secret);
			const decrypted = await decryptWithHKDF(encrypted, secret);
			expect(decrypted).toBe(plaintext);
		});

		it("produces different ciphertext each call (random IV)", async () => {
			const plaintext = "totp-secret-bytes";
			const a = await encryptWithHKDF(plaintext, secret);
			const b = await encryptWithHKDF(plaintext, secret);
			expect(a).not.toBe(b);
		});

		it("fails to decrypt with the wrong auth secret", async () => {
			const plaintext = "totp-secret-bytes";
			const encrypted = await encryptWithHKDF(plaintext, secret);
			await expect(decryptWithHKDF(encrypted, generateAuthSecret())).rejects.toThrow();
		});

		it("is NOT wire-compatible with the PBKDF2 path", async () => {
			// HKDF and PBKDF2 derive different keys from the same secret, so a value
			// encrypted via one path cannot be decrypted via the other. This guard
			// catches accidental cross-wiring during refactors.
			const plaintext = "totp-secret-bytes";
			const pbkdf2 = await encrypt(plaintext, secret);
			await expect(decryptWithHKDF(pbkdf2, secret)).rejects.toThrow();

			const hkdf = await encryptWithHKDF(plaintext, secret);
			await expect(decrypt(hkdf, secret)).rejects.toThrow();
		});
	});
});

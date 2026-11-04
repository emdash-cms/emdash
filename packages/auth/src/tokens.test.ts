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
	validateScopes,
	hasScope,
	isTransferScope,
	TRANSFER_SCOPES,
	VALID_SCOPES,
} from "./tokens.js";

const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;
const NO_PADDING_REGEX = /^[A-Za-z0-9_-]+$/;

describe("tokens", () => {
	describe("validateScopes", () => {
		it("accepts only plugin MCP scopes with valid plugin identifiers", () => {
			expect(validateScopes(["mcp:tools", "mcp:tools:calendar-plugin"])).toEqual([]);
			expect(
				validateScopes([
					"mcp:tools:",
					"mcp:tools:@acme/calendar",
					"mcp:tools:Calendar",
					"mcp:tools:-calendar",
				]),
			).toEqual([
				"mcp:tools:",
				"mcp:tools:@acme/calendar",
				"mcp:tools:Calendar",
				"mcp:tools:-calendar",
			]);
		});
	});

	describe("transfer scopes", () => {
		it("are valid scopes", () => {
			expect(validateScopes([...TRANSFER_SCOPES])).toEqual([]);
			expect(validateScopes(["transfer:import", "transfer:*"])).toEqual([
				"transfer:import",
				"transfer:*",
			]);
		});

		it.each(TRANSFER_SCOPES)("are granted by admin: %s", (scope) => {
			expect(hasScope(["admin"], scope)).toBe(true);
		});

		it.each(TRANSFER_SCOPES)("are not granted by any other scope: %s", (scope) => {
			const others = VALID_SCOPES.filter((s) => s !== "admin" && !isTransferScope(s));
			expect(hasScope(others, scope)).toBe(false);
		});

		it("each grants only itself", () => {
			for (const held of TRANSFER_SCOPES) {
				for (const required of TRANSFER_SCOPES) {
					expect(hasScope([held], required)).toBe(held === required);
				}
				expect(hasScope([held], "admin")).toBe(false);
				expect(hasScope([held], "content:read")).toBe(false);
			}
		});
	});

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

		it("hashes malformed (non-base64url) tokens without throwing", () => {
			for (const malformed of ["!!!", "not a token", "\0", "日本語"]) {
				expect(() => hashToken(malformed)).not.toThrow();
				expect(hashToken(malformed)).toMatch(NO_PADDING_REGEX);
			}
		});

		it("hashes malformed tokens deterministically to a non-matching value", () => {
			const token = generateToken();
			expect(hashToken("!!!")).toBe(hashToken("!!!"));
			expect(hashToken("!!!")).not.toBe(hashToken(token));
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
});

import { describe, it, expect } from "vitest";

import { generateRecoveryCode, generateRecoveryCodes, hashRecoveryCode } from "./recovery-codes.js";
import { RECOVERY_CODE_COUNT } from "./types.js";

const RECOVERY_FORMAT = /^[A-Z2-7]{4}-[A-Z2-7]{4}$/;

describe("generateRecoveryCode", () => {
	it("matches the XXXX-XXXX base32 format", () => {
		const code = generateRecoveryCode();
		expect(code).toMatch(RECOVERY_FORMAT);
		expect(code).toHaveLength(9);
	});

	it("never produces the same code twice in 1000 calls", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 1000; i++) {
			seen.add(generateRecoveryCode());
		}
		expect(seen.size).toBe(1000);
	});
});

describe("generateRecoveryCodes", () => {
	it("returns RECOVERY_CODE_COUNT (10) codes by default", () => {
		const codes = generateRecoveryCodes();
		expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
		expect(codes).toHaveLength(10);
	});

	it("respects an explicit count", () => {
		expect(generateRecoveryCodes(3)).toHaveLength(3);
		expect(generateRecoveryCodes(20)).toHaveLength(20);
	});

	it("every code matches the XXXX-XXXX format", () => {
		const codes = generateRecoveryCodes();
		for (const code of codes) {
			expect(code).toMatch(RECOVERY_FORMAT);
		}
	});

	it("the 10 codes in a set are all distinct", () => {
		const codes = generateRecoveryCodes();
		expect(new Set(codes).size).toBe(codes.length);
	});

	it("throws on count < 1", () => {
		expect(() => generateRecoveryCodes(0)).toThrow(TypeError);
		expect(() => generateRecoveryCodes(-1)).toThrow(TypeError);
	});
});

describe("hashRecoveryCode", () => {
	it("is deterministic — same input → same hash", () => {
		const code = "ABCD-2345";
		expect(hashRecoveryCode(code)).toBe(hashRecoveryCode(code));
	});

	it("is sensitive to a single character change", () => {
		const a = hashRecoveryCode("ABCD-2345");
		const b = hashRecoveryCode("ABCD-2346");
		expect(a).not.toBe(b);
	});

	it("is sensitive to the hyphen — hashes the raw UTF-8 string", () => {
		// hashRecoveryCode uses hashPrefixedToken (raw UTF-8 SHA-256), so
		// removing the hyphen changes the input bytes and therefore the hash.
		// This guards against a future refactor that quietly switches to the
		// base64url-decoding hashToken, which would mangle this input.
		const withHyphen = hashRecoveryCode("ABCD-2345");
		const withoutHyphen = hashRecoveryCode("ABCD2345");
		expect(withHyphen).not.toBe(withoutHyphen);
	});

	it("the hash is not the plaintext", () => {
		const code = "ABCD-2345";
		const hash = hashRecoveryCode(code);
		expect(hash).not.toBe(code);
		expect(hash).not.toContain(code);
	});
});

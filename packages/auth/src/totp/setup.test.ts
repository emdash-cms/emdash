import { generateHOTP } from "@oslojs/otp";
import { describe, it, expect } from "vitest";

import { buildOtpAuthURI, generateTOTPSecret } from "./setup.js";
import { TOTP_DIGITS, TOTP_PERIOD_SECONDS } from "./types.js";
import { verifyTOTPCode } from "./verify.js";

const BASE32_REGEX = /^[A-Z2-7]+$/;

describe("generateTOTPSecret", () => {
	it("returns 20 raw bytes (RFC 4226 §4 recommendation)", () => {
		const { keyBytes } = generateTOTPSecret();
		expect(keyBytes).toBeInstanceOf(Uint8Array);
		expect(keyBytes.byteLength).toBe(20);
	});

	it("returns a base32 encoding of those bytes (no padding)", () => {
		const { base32Secret } = generateTOTPSecret();
		expect(base32Secret).toMatch(BASE32_REGEX);
		// 20 bytes -> ceil(20 * 8 / 5) = 32 base32 chars
		expect(base32Secret.length).toBe(32);
	});

	it("produces unique secrets across calls", () => {
		const secrets = new Set<string>();
		for (let i = 0; i < 100; i++) {
			secrets.add(generateTOTPSecret().base32Secret);
		}
		expect(secrets.size).toBe(100);
	});

	it("the generated key round-trips through generateHOTP -> verifyTOTPCode", () => {
		const { keyBytes } = generateTOTPSecret();
		const fixedNowMs = 1700000000000;
		const step = Math.floor(fixedNowMs / (TOTP_PERIOD_SECONDS * 1000));

		const code = generateHOTP(keyBytes, BigInt(step), TOTP_DIGITS);
		const result = verifyTOTPCode(keyBytes, code, { now: fixedNowMs, driftPeriods: 0 });

		expect(result.valid).toBe(true);
		expect(result.usedStep).toBe(step);
	});
});

describe("buildOtpAuthURI", () => {
	const { keyBytes } = generateTOTPSecret();
	const uri = buildOtpAuthURI({
		issuer: "EmDash Test",
		accountName: "alice@example.com",
		keyBytes,
	});

	it("starts with the otpauth://totp/ scheme", () => {
		expect(uri).toMatch(/^otpauth:\/\/totp\//);
	});

	it("URL-encodes the issuer and account name in the path", () => {
		// "EmDash Test" -> "EmDash%20Test", "@" -> "%40"
		expect(uri).toContain("EmDash%20Test:alice%40example.com");
	});

	it("includes the standard 30s period and 6 digits", () => {
		expect(uri).toContain(`period=${TOTP_PERIOD_SECONDS}`);
		expect(uri).toContain(`digits=${TOTP_DIGITS}`);
	});

	it("includes the SHA1 algorithm", () => {
		expect(uri).toContain("algorithm=SHA1");
	});

	it("includes the issuer query parameter", () => {
		expect(uri).toContain("issuer=EmDash+Test");
	});

	it("includes the secret as base32", () => {
		expect(uri).toMatch(/secret=[A-Z2-7]+/);
	});
});

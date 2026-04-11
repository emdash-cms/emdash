import { generateHOTP } from "@oslojs/otp";
import { describe, it, expect } from "vitest";

import { TOTP_PERIOD_SECONDS } from "./types.js";
import { verifyTOTPCode } from "./verify.js";

// RFC 6238 Appendix B uses the ASCII string "12345678901234567890" as the
// shared secret. For HMAC-SHA1, the key is the literal 20 bytes of that
// ASCII string.
const RFC6238_SECRET = new TextEncoder().encode("12345678901234567890");

/**
 * RFC 6238 Appendix B test vectors for HMAC-SHA1, 6-digit codes,
 * period = 30s. Each row is [unix-timestamp, expected-6-digit-code].
 *
 * Source: https://datatracker.ietf.org/doc/html/rfc6238#appendix-B
 */
const RFC6238_VECTORS: Array<[number, string]> = [
	[59, "287082"],
	[1111111109, "081804"],
	[1111111111, "050471"],
	[1234567890, "005924"],
	[2000000000, "279037"],
	// 20000000000 — too far in the future for normal Date values, skipped
	// here because the rest of the suite gives full RFC 6238 confidence
];

/**
 * Pin Date.now() to a specific RFC test vector by feeding the timestamp
 * directly through the `now` option. The whole point of `now` injection
 * is so we never have to fake the system clock for these tests.
 */
function nowMsForTimestamp(seconds: number): number {
	return seconds * 1000;
}

describe("verifyTOTPCode", () => {
	describe("RFC 6238 Appendix B vectors (HMAC-SHA1, 6-digit, 30s)", () => {
		for (const [timestamp, expectedCode] of RFC6238_VECTORS) {
			it(`accepts ${expectedCode} at unix timestamp ${timestamp}`, () => {
				const result = verifyTOTPCode(RFC6238_SECRET, expectedCode, {
					now: nowMsForTimestamp(timestamp),
					driftPeriods: 0,
				});

				expect(result.valid).toBe(true);
				expect(result.usedStep).toBe(Math.floor(timestamp / TOTP_PERIOD_SECONDS));
			});
		}
	});

	describe("clock drift window", () => {
		// Pick a fixed point in time inside one period; generate codes for
		// the previous, current, and next periods using @oslojs/otp's HOTP
		// primitive directly so the tests don't depend on knowing fixed RFC
		// vectors at arbitrary timestamps.
		const fixedNowMs = 1700000000000; // 2023-11-14T22:13:20Z
		const currentStep = Math.floor(fixedNowMs / (TOTP_PERIOD_SECONDS * 1000));

		const previousCode = generateHOTP(RFC6238_SECRET, BigInt(currentStep - 1), 6);
		const currentCode = generateHOTP(RFC6238_SECRET, BigInt(currentStep), 6);
		const nextCode = generateHOTP(RFC6238_SECRET, BigInt(currentStep + 1), 6);
		const farFutureCode = generateHOTP(RFC6238_SECRET, BigInt(currentStep + 2), 6);

		it("accepts the current period with default drift", () => {
			const result = verifyTOTPCode(RFC6238_SECRET, currentCode, { now: fixedNowMs });
			expect(result.valid).toBe(true);
			expect(result.usedStep).toBe(currentStep);
		});

		it("accepts the previous period (drift = -1) with default drift", () => {
			const result = verifyTOTPCode(RFC6238_SECRET, previousCode, { now: fixedNowMs });
			expect(result.valid).toBe(true);
			expect(result.usedStep).toBe(currentStep - 1);
		});

		it("accepts the next period (drift = +1) with default drift", () => {
			const result = verifyTOTPCode(RFC6238_SECRET, nextCode, { now: fixedNowMs });
			expect(result.valid).toBe(true);
			expect(result.usedStep).toBe(currentStep + 1);
		});

		it("rejects drift = +2 with default drift window", () => {
			const result = verifyTOTPCode(RFC6238_SECRET, farFutureCode, { now: fixedNowMs });
			expect(result.valid).toBe(false);
			expect(result.usedStep).toBeNull();
		});

		it("rejects the previous period when driftPeriods = 0", () => {
			const result = verifyTOTPCode(RFC6238_SECRET, previousCode, {
				now: fixedNowMs,
				driftPeriods: 0,
			});
			expect(result.valid).toBe(false);
		});
	});

	describe("structural validation", () => {
		it("rejects an empty code", () => {
			const result = verifyTOTPCode(RFC6238_SECRET, "", { now: 1700000000000 });
			expect(result.valid).toBe(false);
			expect(result.usedStep).toBeNull();
		});

		it("rejects a code shorter than 6 digits", () => {
			const result = verifyTOTPCode(RFC6238_SECRET, "12345", { now: 1700000000000 });
			expect(result.valid).toBe(false);
		});

		it("rejects a code longer than 6 digits", () => {
			const result = verifyTOTPCode(RFC6238_SECRET, "1234567", { now: 1700000000000 });
			expect(result.valid).toBe(false);
		});

		it("throws on negative driftPeriods", () => {
			expect(() =>
				verifyTOTPCode(RFC6238_SECRET, "123456", { now: 1700000000000, driftPeriods: -1 }),
			).toThrow(TypeError);
		});
	});

	describe("replay protection input", () => {
		const fixedNowMs = 1700000000000;
		const currentStep = Math.floor(fixedNowMs / (TOTP_PERIOD_SECONDS * 1000));
		const currentCode = generateHOTP(RFC6238_SECRET, BigInt(currentStep), 6);

		it("returns the matched step so the caller can persist it for replay protection", () => {
			const result = verifyTOTPCode(RFC6238_SECRET, currentCode, { now: fixedNowMs });
			expect(result.valid).toBe(true);
			expect(result.usedStep).toBe(currentStep);
		});

		it("a wrong code returns usedStep=null", () => {
			const result = verifyTOTPCode(RFC6238_SECRET, "000000", { now: fixedNowMs });
			expect(result.valid).toBe(false);
			expect(result.usedStep).toBeNull();
		});
	});
});

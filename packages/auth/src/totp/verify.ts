/**
 * RFC 6238 TOTP verification with injectable `now` and replay-protection
 * metadata. Delegates HMAC to @oslojs/otp's verifyHOTP (constant-time
 * internally) and computes the counter ourselves so tests can fix time.
 */

import { verifyHOTP } from "@oslojs/otp";

import { TOTP_DIGITS, TOTP_DRIFT_PERIODS, TOTP_PERIOD_SECONDS } from "./types.js";

export interface VerifyTOTPOptions {
	/** Unix ms. Defaults to Date.now(); inject in tests. */
	now?: number;
	periodSeconds?: number;
	digits?: number;
	/** Steps to check on each side of current. Default 1. */
	driftPeriods?: number;
}

export interface VerifyTOTPResult {
	valid: boolean;
	/** Matched epoch counter, or null when valid=false. Persist as lastUsedStep. */
	usedStep: number | null;
}

/**
 * Verify a TOTP code. `key` is the raw secret bytes (decrypt the stored
 * blob first). The loop does not short-circuit on match so timing
 * doesn't leak which drift step succeeded.
 */
export function verifyTOTPCode(
	key: Uint8Array,
	code: string,
	options: VerifyTOTPOptions = {},
): VerifyTOTPResult {
	const now = options.now ?? Date.now();
	const periodSeconds = options.periodSeconds ?? TOTP_PERIOD_SECONDS;
	const digits = options.digits ?? TOTP_DIGITS;
	const driftPeriods = options.driftPeriods ?? TOTP_DRIFT_PERIODS;

	if (driftPeriods < 0) {
		throw new TypeError("driftPeriods must be >= 0");
	}

	if (code.length !== digits) {
		return { valid: false, usedStep: null };
	}

	const currentStep = Math.floor(now / (periodSeconds * 1000));
	const startStep = currentStep - driftPeriods;
	const endStep = currentStep + driftPeriods;

	let matchedStep: number | null = null;
	for (let step = startStep; step <= endStep; step++) {
		const stepValid = verifyHOTP(key, BigInt(step), digits, code);
		if (stepValid && matchedStep === null) {
			matchedStep = step;
		}
	}

	if (matchedStep === null) {
		return { valid: false, usedStep: null };
	}
	return { valid: true, usedStep: matchedStep };
}

/**
 * RFC 6238 TOTP verification with full dependency injection for the
 * current time, and replay protection via the matched epoch counter.
 *
 * We don't call @oslojs/otp's verifyTOTP / verifyTOTPWithGracePeriod
 * directly because they read Date.now() internally — there's no way
 * to inject the clock for tests. Instead we delegate the HOTP primitive
 * to @oslojs/otp (which uses the same HMAC-SHA1 / RFC 4226 truncation
 * everyone trusts) and compute the counter ourselves.
 *
 * The valid return value carries the matched step so the caller can
 * persist it as `lastUsedStep` and reject any later code whose candidate
 * step is `<= lastUsedStep` — that's RFC 6238 §5.2 replay protection.
 */

import { verifyHOTP } from "@oslojs/otp";

import { TOTP_DIGITS, TOTP_DRIFT_PERIODS, TOTP_PERIOD_SECONDS } from "./types.js";

/**
 * Optional knobs for verifyTOTPCode. All have sensible defaults — only
 * `now` is meant for production callers (and only when they want to
 * verify against a specific point in time, e.g. testing).
 */
export interface VerifyTOTPOptions {
	/** Current time in unix milliseconds. Defaults to Date.now() — pass a fixed value in tests. */
	now?: number;
	/** Period in seconds. Defaults to 30. */
	periodSeconds?: number;
	/** Digit count. Defaults to 6. */
	digits?: number;
	/**
	 * How many TOTP periods on each side of `now` count as valid. Defaults
	 * to ±1 period (±30s of clock drift tolerance). Must be >= 0.
	 */
	driftPeriods?: number;
}

/**
 * Result of a TOTP verification attempt. `valid` tells the caller whether
 * the code matched any candidate counter in the drift window; `usedStep`
 * is the matching counter (use this for replay protection by storing it
 * as `lastUsedStep` on the credential row).
 */
export interface VerifyTOTPResult {
	valid: boolean;
	/** The epoch counter that matched, or null when valid=false. */
	usedStep: number | null;
}

/**
 * Verify a 6-digit (or N-digit) TOTP code against an HMAC key using
 * RFC 6238 with a configurable clock-drift window.
 *
 * The key must be the raw secret bytes (the same Uint8Array that
 * @oslojs/otp.createTOTPKeyURI accepts), NOT the encrypted-at-rest blob.
 * Decrypt the stored secret first, then call this.
 *
 * Always traverses the full drift window — does NOT short-circuit on the
 * first match — so a successful match against the previous period costs
 * the same as a successful match against the current period. The HOTP
 * primitive itself uses constant-time comparison (verified in
 * @oslojs/otp/dist/hotp.js).
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

	// Cheap structural check before doing any HMAC work — this also rejects
	// non-numeric input that could confuse the HOTP comparator. Unlike the
	// HMAC compare, this check is allowed to short-circuit because the input
	// length carries no secret information.
	if (code.length !== digits) {
		return { valid: false, usedStep: null };
	}

	const currentStep = Math.floor(now / (periodSeconds * 1000));
	const startStep = currentStep - driftPeriods;
	const endStep = currentStep + driftPeriods;

	let matchedStep: number | null = null;

	for (let step = startStep; step <= endStep; step++) {
		// Important: keep iterating after a match. Short-circuiting on a hit
		// would leak (via timing) which counter matched within the drift
		// window. The window is small (3 iterations by default) so the cost
		// is negligible.
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

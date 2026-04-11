/**
 * Recovery codes for TOTP — single-use fallback codes the user saves at
 * enrollment time and uses when they lose their authenticator app.
 *
 * Format: 8 base32 chars displayed as `XXXX-XXXX` with a hyphen between
 * groups of 4 for readability. 5 random bytes per code = 40 bits of
 * entropy, which is more than enough given the brute-force surface is
 * gated by per-account rate limiting + 10-failure lockout + single-use
 * deletion on first successful match.
 *
 * Storage: codes are hashed via hashPrefixedToken (UTF-8 SHA-256, NOT
 * the base64url-decoding hashToken — these strings aren't base64url and
 * decoding them as such would mangle the input). The hash goes in the
 * existing auth_tokens table with type='recovery', so we don't need a
 * new table for codes.
 *
 * Discussion: https://github.com/emdash-cms/emdash/discussions/432
 */

import { encodeBase32NoPadding } from "@oslojs/encoding";

import { hashPrefixedToken } from "../tokens.js";
import { RECOVERY_CODE_COUNT } from "./types.js";

/**
 * Number of random bytes per recovery code. 5 bytes -> 8 base32 chars -> 40 bits.
 *
 * Why 5 not more: the hyphenated `XXXX-XXXX` shape only fits 8 chars, and
 * 40 bits is well past the threshold the rate-limit + lockout + single-use
 * gates make brute-force pointless. Bumping to 10 bytes (16 chars displayed
 * as `XXXX-XXXX-XXXX-XXXX`) is harder to type and harder to read aloud
 * for zero security benefit.
 */
const RECOVERY_CODE_BYTES = 5;

/**
 * Generate a single recovery code as `XXXX-XXXX` from 5 random bytes.
 *
 * Exported separately from generateRecoveryCodes so tests can verify the
 * format independently of the count.
 */
export function generateRecoveryCode(): string {
	const bytes = new Uint8Array(RECOVERY_CODE_BYTES);
	crypto.getRandomValues(bytes);
	const encoded = encodeBase32NoPadding(bytes);
	// Insert a hyphen between the two groups of 4 for readability.
	return `${encoded.slice(0, 4)}-${encoded.slice(4, 8)}`;
}

/**
 * Generate a fresh set of recovery codes for a new TOTP enrollment.
 *
 * Returns the codes in plaintext — the route handler shows them to the
 * user once and never again, then persists only the hashes via
 * hashRecoveryCode.
 */
export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
	if (count < 1) {
		throw new TypeError("Recovery code count must be >= 1");
	}
	const codes: string[] = [];
	for (let i = 0; i < count; i++) {
		codes.push(generateRecoveryCode());
	}
	return codes;
}

/**
 * Hash a recovery code for storage in auth_tokens.
 *
 * IMPORTANT: this uses hashPrefixedToken (raw UTF-8 SHA-256) NOT hashToken
 * (which expects base64url input and would mangle the hyphen). At login
 * time, the verifier hashes the user-supplied code with the same function
 * and looks up the row by hash.
 */
export function hashRecoveryCode(code: string): string {
	return hashPrefixedToken(code);
}

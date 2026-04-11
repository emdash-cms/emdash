/**
 * TOTP enrollment helpers — secret generation and otpauth:// URI assembly
 * for QR rendering.
 *
 * Pure functions, no DB. The route handler is responsible for encrypting
 * the secret bytes via encryptWithHKDF and persisting them; for verifying
 * the user's first code via verifyTOTPCode; and for storing the credential
 * row in totp_secrets via the adapter.
 *
 * The split is deliberate: setup.ts only handles the cryptographic
 * primitives so it can be exercised in isolation, with no database, no
 * encryption secret, and no time dependence.
 */

import { encodeBase32NoPadding } from "@oslojs/encoding";
import { createTOTPKeyURI } from "@oslojs/otp";

import { TOTP_DIGITS, TOTP_PERIOD_SECONDS } from "./types.js";

/**
 * Per RFC 4226 §4 the shared secret SHOULD be at least 128 bits and the
 * recommended length is 160 bits (20 bytes). 160 bits is also the natural
 * HMAC-SHA1 block boundary. We pick 20 bytes — same length the RFC 6238
 * Appendix B test vectors use.
 */
const SECRET_BYTES = 20;

/**
 * A freshly generated TOTP secret, ready to be encrypted and persisted
 * (via `keyBytes`) and shown to the user in a QR code or as a fallback
 * text string (via `base32Secret`).
 *
 * The two fields are the same secret, just encoded differently:
 * - `keyBytes` is the raw 20 bytes that the verify primitive consumes.
 *   Encrypt this with encryptWithHKDF before storing.
 * - `base32Secret` is the same bytes encoded as RFC 4648 base32 (no
 *   padding) — that's the format users paste into authenticator apps
 *   when QR scanning fails.
 */
export interface GeneratedTOTPSecret {
	keyBytes: Uint8Array;
	base32Secret: string;
}

/**
 * Generate a fresh TOTP secret using the platform CSPRNG.
 *
 * Returns both the raw bytes (for encryption + storage + verification)
 * and the base32 encoding (for the "Can't scan? Enter this code" fallback
 * UI on the QR screen).
 */
export function generateTOTPSecret(): GeneratedTOTPSecret {
	const keyBytes = new Uint8Array(SECRET_BYTES);
	crypto.getRandomValues(keyBytes);
	return {
		keyBytes,
		base32Secret: encodeBase32NoPadding(keyBytes),
	};
}

/**
 * Inputs for buildOtpAuthURI.
 */
export interface OtpAuthURIOptions {
	/**
	 * Identifier of the deploying organization or site, e.g. "EmDash" or
	 * the site title from settings. Shown by authenticator apps as the
	 * group label so a user with multiple TOTP accounts can tell them
	 * apart. URL-encoded internally.
	 */
	issuer: string;
	/**
	 * Identifier of the user account being enrolled, typically their
	 * email. Shown by authenticator apps under the issuer label.
	 * URL-encoded internally.
	 */
	accountName: string;
	/** Raw secret bytes — the same `keyBytes` returned by generateTOTPSecret. */
	keyBytes: Uint8Array;
}

/**
 * Build an otpauth:// URI for the QR code an authenticator app will scan.
 *
 * Wraps @oslojs/otp's createTOTPKeyURI with our standard period/digits so
 * call sites only have to provide the user-facing labels and the secret.
 * The output looks like:
 *
 *   otpauth://totp/MySite:alice@example.com
 *     ?issuer=MySite&algorithm=SHA1&secret=...&period=30&digits=6
 *
 * That string is what gets rendered to a QR code in the setup wizard,
 * and what gets exposed under the "Can't scan? Enter this code" disclosure
 * (via the base32Secret field on GeneratedTOTPSecret — the URI itself is
 * the QR payload, not the user-facing fallback).
 */
export function buildOtpAuthURI(options: OtpAuthURIOptions): string {
	return createTOTPKeyURI(
		options.issuer,
		options.accountName,
		options.keyBytes,
		TOTP_PERIOD_SECONDS,
		TOTP_DIGITS,
	);
}

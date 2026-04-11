/** Pure helpers for generating a TOTP secret and its otpauth:// URI. */

import { encodeBase32NoPadding } from "@oslojs/encoding";
import { createTOTPKeyURI } from "@oslojs/otp";

import { TOTP_DIGITS, TOTP_PERIOD_SECONDS } from "./types.js";

/** 160 bits — RFC 4226 §4 recommended length. */
const SECRET_BYTES = 20;

export interface GeneratedTOTPSecret {
	/** Raw bytes for the verify primitive. Encrypt before persisting. */
	keyBytes: Uint8Array;
	/** Base32 encoding of the same bytes, for the "Can't scan?" fallback. */
	base32Secret: string;
}

export function generateTOTPSecret(): GeneratedTOTPSecret {
	const keyBytes = new Uint8Array(SECRET_BYTES);
	crypto.getRandomValues(keyBytes);
	return {
		keyBytes,
		base32Secret: encodeBase32NoPadding(keyBytes),
	};
}

export interface OtpAuthURIOptions {
	/** Group label shown by authenticator apps (e.g. the site title). */
	issuer: string;
	/** Account identifier, typically the user's email. */
	accountName: string;
	keyBytes: Uint8Array;
}

export function buildOtpAuthURI(options: OtpAuthURIOptions): string {
	return createTOTPKeyURI(
		options.issuer,
		options.accountName,
		options.keyBytes,
		TOTP_PERIOD_SECONDS,
		TOTP_DIGITS,
	);
}

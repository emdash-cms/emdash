/**
 * Shared helper for reading EMDASH_AUTH_SECRET from the environment.
 *
 * Used by every route that needs to encrypt or decrypt with the
 * platform auth secret (TOTP enroll, TOTP verify, TOTP login, and
 * anything else that arrives later). Centralizing the read here means:
 *
 *   - One place states the env var precedence (EMDASH_AUTH_SECRET
 *     first, then AUTH_SECRET as a fallback, matching the existing
 *     pattern elsewhere in the codebase).
 *   - One place states the length floor (32 chars — base64url of 24
 *     bytes at minimum; the `emdash auth secret` CLI generates 32
 *     random bytes which encodes to 43 chars).
 *   - Routes get a result-shaped return rather than an exception, so
 *     they can map the failure to a specific user-facing error code
 *     without relying on catch-blocks + string matching.
 *
 * Why not throw: route handlers already catch everything to return
 * HTTP errors, but a thrown `Error` loses the structured reason —
 * the handler would have to sniff the message string to distinguish
 * "missing" from "too short" from "corrupted". A result union is
 * cheaper and more precise.
 */

/** Minimum acceptable secret length in characters. */
const MIN_SECRET_LENGTH = 32;

/**
 * Result of attempting to read the auth secret from the environment.
 *
 * On success, the secret is returned as-is. On failure, the reason is
 * a stable string that callers can map to error codes without parsing
 * human-readable messages.
 */
export type AuthSecretResult =
	| { ok: true; secret: string }
	| { ok: false; reason: "missing" | "too_short" };

/**
 * Read the EMDASH_AUTH_SECRET from the environment.
 *
 * Falls back to AUTH_SECRET (same pattern used by other EmDash env
 * vars) before declaring the secret missing. Does NOT fall back to
 * a hardcoded value — encrypting with a default would silently
 * invalidate every stored secret across deploys.
 */
export function resolveAuthSecret(): AuthSecretResult {
	const secret = import.meta.env.EMDASH_AUTH_SECRET || import.meta.env.AUTH_SECRET || "";

	if (!secret) {
		return { ok: false, reason: "missing" };
	}
	if (secret.length < MIN_SECRET_LENGTH) {
		return { ok: false, reason: "too_short" };
	}
	return { ok: true, secret };
}

/**
 * One-line user-facing message for an auth secret failure. Shown in
 * 500 responses and logged by the integration at startup. Always
 * ends with the exact command the deployer should run next, no
 * hedging.
 */
export function authSecretFailureMessage(reason: "missing" | "too_short"): string {
	if (reason === "missing") {
		return "EMDASH_AUTH_SECRET is not set. Run `emdash auth secret` to generate one and add it to your environment, then restart the dev server.";
	}
	return `EMDASH_AUTH_SECRET is set but shorter than ${MIN_SECRET_LENGTH} characters. Run \`emdash auth secret\` to generate a fresh one and replace it in your environment.`;
}

/** Read EMDASH_AUTH_SECRET from the environment. Result-shaped so route
 * handlers can map specific failures to error codes without parsing
 * exception messages. Never falls back to a hardcoded default — that
 * would silently invalidate every stored secret across deploys. */

const MIN_SECRET_LENGTH = 32;
// Base64url alphabet per RFC 4648 §5 (URL and Filename safe). The auth
// helpers decode the secret with decodeBase64urlIgnorePadding, which
// throws synchronously on any character outside this set — we want to
// report that as a format error up front instead of a runtime 500 deep
// inside encrypt/decrypt.
const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;

export type AuthSecretFailureReason = "missing" | "too_short" | "invalid_format";

export type AuthSecretResult =
	| { ok: true; secret: string }
	| { ok: false; reason: AuthSecretFailureReason };

export function resolveAuthSecret(): AuthSecretResult {
	const secret = import.meta.env.EMDASH_AUTH_SECRET || import.meta.env.AUTH_SECRET || "";
	if (!secret) return { ok: false, reason: "missing" };
	if (secret.length < MIN_SECRET_LENGTH) return { ok: false, reason: "too_short" };
	if (!BASE64URL_REGEX.test(secret)) return { ok: false, reason: "invalid_format" };
	return { ok: true, secret };
}

export function authSecretFailureMessage(reason: AuthSecretFailureReason): string {
	if (reason === "missing") {
		return "EMDASH_AUTH_SECRET is not set. Run `emdash auth secret` to generate one and add it to your environment, then restart the dev server.";
	}
	if (reason === "too_short") {
		return `EMDASH_AUTH_SECRET is set but shorter than ${MIN_SECRET_LENGTH} characters. Run \`emdash auth secret\` to generate a fresh one and replace it in your environment.`;
	}
	return "EMDASH_AUTH_SECRET contains characters outside the base64url alphabet (A-Z, a-z, 0-9, -, _). Run `emdash auth secret` to generate a valid one and replace it in your environment.";
}

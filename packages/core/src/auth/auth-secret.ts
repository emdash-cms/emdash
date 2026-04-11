/** Read EMDASH_AUTH_SECRET from the environment. Result-shaped so route
 * handlers can map specific failures to error codes without parsing
 * exception messages. Never falls back to a hardcoded default — that
 * would silently invalidate every stored secret across deploys. */

const MIN_SECRET_LENGTH = 32;

export type AuthSecretResult =
	| { ok: true; secret: string }
	| { ok: false; reason: "missing" | "too_short" };

export function resolveAuthSecret(): AuthSecretResult {
	const secret = import.meta.env.EMDASH_AUTH_SECRET || import.meta.env.AUTH_SECRET || "";
	if (!secret) return { ok: false, reason: "missing" };
	if (secret.length < MIN_SECRET_LENGTH) return { ok: false, reason: "too_short" };
	return { ok: true, secret };
}

export function authSecretFailureMessage(reason: "missing" | "too_short"): string {
	if (reason === "missing") {
		return "EMDASH_AUTH_SECRET is not set. Run `emdash auth secret` to generate one and add it to your environment, then restart the dev server.";
	}
	return `EMDASH_AUTH_SECRET is set but shorter than ${MIN_SECRET_LENGTH} characters. Run \`emdash auth secret\` to generate a fresh one and replace it in your environment.`;
}

/**
 * Server-side Turnstile verification for public comment submissions and
 * the admin's email sign-in and self-signup forms.
 *
 * The comment form widget (`CommentForm.astro`) submits a `turnstileToken`;
 * this verifies it against Cloudflare's siteverify API. Enforcement is
 * opt-in: comments are checked when the operator configures the Turnstile
 * secret key (`EMDASH_TURNSTILE_SECRET_KEY` or `TURNSTILE_SECRET_KEY`), and
 * the admin auth forms are checked when `EMDASH_TURNSTILE_SITE_KEY` is set
 * as well, so existing non-Turnstile sites are unaffected.
 *
 * Mirrors `verifyTurnstile` in `@emdash-cms/plugin-forms` (not imported —
 * core doesn't depend on plugin packages).
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Resolve the configured Turnstile secret key, or `""` when Turnstile
 * enforcement is not configured.
 *
 * Reads `process.env` only: Vite replaces `import.meta.env` at build time,
 * which would bake a build-machine secret into the bundle and hide a secret
 * set on the deployment platform.
 */
export function getTurnstileSecretKey(): string {
	const env = typeof process !== "undefined" && process.env ? process.env : {};
	return env.EMDASH_TURNSTILE_SECRET_KEY || env.TURNSTILE_SECRET_KEY || "";
}

/**
 * Resolve the Turnstile keys for the admin's email sign-in and self-signup
 * forms, or `null` when either key is missing. The site key is sent to the
 * browser; the secret key never leaves the server.
 */
export function getAuthTurnstileKeys(): { siteKey: string; secretKey: string } | null {
	const env = typeof process !== "undefined" && process.env ? process.env : {};
	const siteKey = env.EMDASH_TURNSTILE_SITE_KEY || "";
	const secretKey = getTurnstileSecretKey();
	return siteKey && secretKey ? { siteKey, secretKey } : null;
}

/**
 * Verify a Turnstile response token via siteverify.
 *
 * Fails closed: a missing token, a failed verification, and a siteverify
 * transport error all return `false` — when the operator has configured a
 * secret, an unverifiable submission must not be persisted.
 */
export async function verifyTurnstileToken(
	token: string | undefined,
	secretKey: string,
	remoteIp?: string | null,
): Promise<boolean> {
	if (!token) return false;

	const body: Record<string, string> = { secret: secretKey, response: token };
	if (remoteIp) {
		body.remoteip = remoteIp;
	}

	try {
		const res = await fetch(SITEVERIFY_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			// Fail closed *quickly* if siteverify is slow — without a timeout
			// the request would hang until the runtime kills it
			signal: AbortSignal.timeout(10_000),
		});
		const data: { success?: boolean; "error-codes"?: string[] } = await res.json();
		if (!data.success) {
			console.warn("[turnstile] Turnstile verification failed:", data["error-codes"] ?? []);
		}
		return data.success === true;
	} catch (error) {
		console.error(
			"[turnstile] Turnstile siteverify request failed:",
			error instanceof Error ? error.message : error,
		);
		return false;
	}
}

/**
 * Server-side Turnstile verification for public comment submissions.
 *
 * The comment form widget (`CommentForm.astro`) submits a `turnstileToken`;
 * this verifies it against Cloudflare's siteverify API. Enforcement is
 * opt-in: it only runs when the operator configures the Turnstile secret
 * key (`EMDASH_TURNSTILE_SECRET_KEY` or `TURNSTILE_SECRET_KEY`), so
 * existing non-Turnstile sites are unaffected.
 *
 * Mirrors `verifyTurnstile` in `@emdash-cms/plugin-forms` (not imported —
 * core doesn't depend on plugin packages).
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Resolve the configured Turnstile secret key, or `""` when Turnstile
 * enforcement is not configured.
 */
export function getTurnstileSecretKey(): string {
	return import.meta.env.EMDASH_TURNSTILE_SECRET_KEY || import.meta.env.TURNSTILE_SECRET_KEY || "";
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
			// the comment POST would hang until the runtime kills it
			signal: AbortSignal.timeout(10_000),
		});
		const data: { success?: boolean; "error-codes"?: string[] } = await res.json();
		if (!data.success) {
			console.warn("[comments] Turnstile verification failed:", data["error-codes"] ?? []);
		}
		return data.success === true;
	} catch (error) {
		console.error(
			"[comments] Turnstile siteverify request failed:",
			error instanceof Error ? error.message : error,
		);
		return false;
	}
}

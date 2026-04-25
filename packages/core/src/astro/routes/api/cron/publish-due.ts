/**
 * POST /_emdash/api/cron/publish-due
 *
 * Publishes all content items whose scheduled_at has passed and fires
 * configured rebuildHooks if any content was published.
 *
 * Auth: Bearer token via EMDASH_CRON_SECRET env var.
 * If the env var is not set, only requests from localhost are accepted
 * (dev mode). Suitable for Vercel Cron Jobs, Cloudflare Workers cron
 * triggers, or any HTTP scheduler that can set the Authorization header.
 */

import type { APIRoute } from "astro";

import { apiError, handleError } from "#api/error.js";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash } = locals;

	if (!emdash?.handleContentPublishDue) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	// Auth check: require EMDASH_CRON_SECRET when set, else allow localhost only.
	const cronSecret = import.meta.env.EMDASH_CRON_SECRET || import.meta.env.CRON_SECRET || "";

	if (cronSecret) {
		const authHeader = request.headers.get("Authorization") ?? "";
		const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
		// Constant-time comparison: hash both to fixed-length 32-byte digests, then XOR every
		// byte pair. This avoids crypto.subtle.timingSafeEqual (Workers extension, not on Node).
		// SHA-256 pre-hash also eliminates length-leaking short-circuit.
		const enc = new TextEncoder();
		const [hashA, hashB] = await Promise.all([
			crypto.subtle.digest("SHA-256", enc.encode(token)),
			crypto.subtle.digest("SHA-256", enc.encode(cronSecret)),
		]);
		const a = new Uint8Array(hashA);
		const b = new Uint8Array(hashB);
		let diff = 0;
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- tsgo needs these
		for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
		if (diff !== 0) return apiError("UNAUTHORIZED", "Invalid cron secret", 401);
	} else if (!import.meta.env.DEV) {
		// No secret configured and not in dev mode — refuse rather than run unprotected.
		return apiError(
			"NOT_CONFIGURED",
			"EMDASH_CRON_SECRET is not configured. Set it to enable this endpoint.",
			503,
		);
	}

	try {
		const result = await emdash.handleContentPublishDue();
		if (!result.success) {
			return Response.json(result, { status: 500 });
		}
		return Response.json(result.data);
	} catch (error) {
		return handleError(error, "Failed to publish due content", "PUBLISH_DUE_ERROR");
	}
};

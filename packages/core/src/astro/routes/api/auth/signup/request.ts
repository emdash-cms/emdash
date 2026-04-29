/**
 * POST /_emdash/api/auth/signup/request
 *
 * Request self-signup. Sends verification email if domain is allowed.
 * Always returns 200 to prevent email enumeration.
 *
 * Rate limited: 3 requests per 5 minutes per IP. Mirrors magic-link/send.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { requestSignup } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";

import { apiError, apiSuccess } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { signupRequestBody } from "#api/schemas.js";
import { getSiteBaseUrl } from "#api/site-url.js";
import { checkRateLimit, getClientIp } from "#auth/rate-limit.js";
import { getTrustedProxyHeaders } from "#auth/trusted-proxy.js";
import { OptionsRepository } from "#db/repositories/options.js";

// Generic response body used for both the real success path and the
// rate-limited / domain-disallowed paths. Keeping them identical prevents
// the caller from distinguishing between them.
const GENERIC_SUCCESS = {
	success: true,
	message: "If your email domain is allowed, you'll receive a verification email.",
};

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	// Check if email pipeline is available
	if (!emdash.email?.isAvailable()) {
		return apiError(
			"EMAIL_NOT_CONFIGURED",
			"Email not configured. Self-signup is unavailable.",
			503,
		);
	}

	try {
		// Parse the body first — this avoids burning a rate-limit slot on
		// malformed input and keeps the timing of the rate-limited and
		// real paths aligned.
		const body = await parseBody(request, signupRequestBody);
		if (isParseError(body)) return body;

		// Rate limit: 3 requests per 300 seconds per IP. Matches magic-link/send.
		const ip = getClientIp(request, getTrustedProxyHeaders(emdash.config));
		const rateLimit = await checkRateLimit(emdash.db, ip, "signup/request", 3, 300);
		if (!rateLimit.allowed) {
			// Return success-shaped response to avoid revealing rate limiting
			// (and by extension, the fact that the caller is probing).
			return apiSuccess(GENERIC_SUCCESS);
		}

		const adapter = createKyselyAdapter(emdash.db);

		// Get site config for signup email
		const options = new OptionsRepository(emdash.db);
		const siteName = (await options.get<string>("emdash:site_title")) || "EmDash";

		// Use stored site URL to prevent Host header spoofing in signup emails
		const baseUrl = await getSiteBaseUrl(emdash.db, request);

		// Request signup - this handles all checks internally and fails silently
		// if domain not allowed or user exists (to prevent enumeration)
		await requestSignup(
			{
				baseUrl,
				siteName,
				email: (message) => emdash.email!.send(message, "system"),
			},
			adapter,
			body.email.toLowerCase().trim(),
		);

		// Always return success to prevent email enumeration
		return apiSuccess(GENERIC_SUCCESS);
	} catch (error) {
		console.error("Signup request error:", error);

		// Don't reveal internal errors - just return generic success
		// to prevent information leakage
		return apiSuccess(GENERIC_SUCCESS);
	}
};

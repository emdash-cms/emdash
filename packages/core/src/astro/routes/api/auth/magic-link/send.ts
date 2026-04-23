/**
 * POST /_emdash/api/auth/magic-link/send
 *
 * Send a magic link email for passwordless authentication.
 * Always returns success to avoid revealing whether email exists.
 *
 * Rate limited: 3 requests per 5 minutes per IP.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { sendMagicLink, type MagicLinkConfig } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";

import { apiError, apiSuccess } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { magicLinkSendBody } from "#api/schemas.js";
import { getSiteBaseUrl } from "#api/site-url.js";
import { checkRateLimit, getClientIp } from "#auth/rate-limit.js";
import { getTrustedProxyHeaders } from "#auth/trusted-proxy.js";
import { OptionsRepository } from "#db/repositories/options.js";

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	try {
		// Parse request body first — avoids consuming rate limit slots on
		// malformed requests and normalizes timing between rate-limited
		// and real paths (parse cost evens out the response time).
		const body = await parseBody(request, magicLinkSendBody);
		if (isParseError(body)) return body;

		// Rate limit: 3 requests per 300 seconds (5 minutes) per IP
		const ip = getClientIp(request, getTrustedProxyHeaders(emdash.config));
		const rateLimit = await checkRateLimit(emdash.db, ip, "magic-link/send", 3, 300);
		if (!rateLimit.allowed) {
			// Return success-shaped response to avoid revealing rate limit
			// (which could leak information about email enumeration attempts)
			return apiSuccess({
				success: true,
				message: "If an account exists for this email, a magic link has been sent.",
			});
		}

		// Check if email pipeline is available
		if (!emdash.email?.isAvailable()) {
			return apiError(
				"EMAIL_NOT_CONFIGURED",
				"Email is not configured. Magic link authentication requires an email provider.",
				503,
			);
		}

		// Build magic link config using stored site URL (not request Host header)
		const options = new OptionsRepository(emdash.db);
		const baseUrl = await getSiteBaseUrl(emdash.db, request);
		const siteName = (await options.get<string>("emdash:site_title")) ?? "EmDash";

		const config: MagicLinkConfig = {
			baseUrl,
			siteName,
			email: (message) => emdash.email!.send(message, "system"),
		};

		// Send magic link (silently fails if user doesn't exist)
		const adapter = createKyselyAdapter(emdash.db);
		await sendMagicLink(config, adapter, body.email.toLowerCase());

		// Always return success to avoid revealing if email exists
		return apiSuccess({
			success: true,
			message: "If an account exists for this email, a magic link has been sent.",
		});
	} catch (error) {
		console.error("Magic link send error:", error);

		// Still return success to avoid revealing information
		// Log the error but don't expose it to the client
		return apiSuccess({
			success: true,
			message: "If an account exists for this email, a magic link has been sent.",
		});
	}
};

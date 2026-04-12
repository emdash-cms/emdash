/**
 * POST /_emdash/api/oauth/device/code
 *
 * Issue a device code + user code for the OAuth Device Flow.
 * This is an unauthenticated endpoint (the CLI doesn't have a token yet).
 *
 * Rate limited: 10 requests per minute per IP.
 */

import type { APIRoute } from "astro";
import { z } from "zod";

import { apiError, handleError, unwrapResult } from "#api/error.js";
import { handleDeviceCodeRequest } from "#api/handlers/device-flow.js";
import { isParseError, parseBody } from "#api/parse.js";
import { getPublicOrigin } from "#api/public-url.js";
import { checkRateLimit, getClientIp, rateLimitResponse } from "#auth/rate-limit.js";

export const prerender = false;

const deviceCodeSchema = z.object({
	client_id: z.string().optional(),
	scope: z.string().optional(),
});

export const POST: APIRoute = async ({ request, locals, url }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	try {
		const body = await parseBody(request, deviceCodeSchema);
		if (isParseError(body)) return body;

		// Rate limit: 10 requests per 60 seconds per IP
		const ip = getClientIp(request);
		const rateLimit = await checkRateLimit(emdash.db, ip, "device/code", 10, 60);
		if (!rateLimit.allowed) {
			return rateLimitResponse(60);
		}

		// Build the verification URI — device page lives inside the admin SPA
		const verificationUri = new URL(
			"/_emdash/admin/device",
			getPublicOrigin(url, emdash?.config),
		).toString();

		const result = await handleDeviceCodeRequest(emdash.db, body, verificationUri);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to create device code", "DEVICE_CODE_ERROR");
	}
};

/**
 * POST /_emdash/api/oauth/device/token
 *
 * CLI polls this endpoint to exchange a device code for tokens.
 * Returns RFC 8628 error codes during the polling phase.
 * This is an unauthenticated endpoint.
 *
 * Rate limited: 12 requests per minute per IP.
 * Also enforces RFC 8628 slow_down: if polled faster than the interval,
 * responds with { error: "slow_down", interval: N } and increases the interval by 5s.
 */

import type { APIRoute } from "astro";
import { z } from "zod";

import { apiError, handleError, unwrapResult } from "#api/error.js";
import { handleDeviceTokenExchange } from "#api/handlers/device-flow.js";
import { isParseError, parseBody } from "#api/parse.js";
import { checkRateLimit, getClientIp, rateLimitResponse } from "#auth/rate-limit.js";
import { getTrustedProxyHeaders } from "#auth/trusted-proxy.js";

export const prerender = false;

const deviceTokenSchema = z.object({
	device_code: z.string().min(1),
	grant_type: z.string().min(1),
});

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	try {
		const body = await parseBody(request, deviceTokenSchema);
		if (isParseError(body)) return body;

		// Rate limit: 12 requests per 60 seconds per IP
		const ip = getClientIp(request, getTrustedProxyHeaders(emdash.config));
		const rateLimit = await checkRateLimit(emdash.db, ip, "device/token", 12, 60);
		if (!rateLimit.allowed) {
			return rateLimitResponse(60);
		}

		const result = await handleDeviceTokenExchange(emdash.db, body);

		// RFC 8628 requires specific error format for device flow errors
		// RFC 6749 §5.1 requires Cache-Control: no-store + Pragma: no-cache on token responses
		if (!result.success && result.deviceFlowError) {
			const errorBody: { error: string; interval?: number } = { error: result.deviceFlowError };
			if (result.deviceFlowInterval !== undefined) {
				errorBody.interval = result.deviceFlowInterval;
			}
			return Response.json(errorBody, {
				status: 400,
				headers: {
					"Content-Type": "application/json",
					"Cache-Control": "no-store",
					Pragma: "no-cache",
				},
			});
		}

		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to exchange device code", "TOKEN_EXCHANGE_ERROR");
	}
};

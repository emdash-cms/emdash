import type { APIRoute } from "astro";

import { handleError, requireDb, unwrapResult } from "#api/error.js";
import { handleShopBookingHold } from "#api/handlers/booking.js";
import { isParseError, parseBody } from "#api/parse.js";
import { shopBookingHoldBody } from "#api/schemas.js";
import { checkRateLimit, getClientIp, rateLimitResponse } from "#auth/rate-limit.js";
import { getTrustedProxyHeaders } from "#auth/trusted-proxy.js";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
	const dbError = requireDb(locals.emdash?.db);
	if (dbError) return dbError;
	const ip = getClientIp(request, getTrustedProxyHeaders(locals.emdash.config));
	const rateLimit = await checkRateLimit(locals.emdash.db, ip, "shop/reservations/hold", 20, 60);
	if (!rateLimit.allowed) return rateLimitResponse(60);
	try {
		const body = await parseBody(request, shopBookingHoldBody);
		if (isParseError(body)) return body;
		return unwrapResult(await handleShopBookingHold(locals.emdash.db, body));
	} catch (error) {
		return handleError(error, "Failed to hold booking", "SHOP_BOOKING_HOLD_ERROR");
	}
};

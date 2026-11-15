import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { handleError, requireDb, unwrapResult } from "#api/error.js";
import { handleShopEnrollmentUpdate } from "#api/handlers/enrollment.js";
import { isParseError, parseBody } from "#api/parse.js";
import { shopEnrollmentUpdateBody } from "#api/schemas.js";

export const prerender = false;

export const PATCH: APIRoute = async ({ request, locals, params }) => {
	const denied = requirePerm(locals.user, "shop:manage");
	if (denied) return denied;
	const dbError = requireDb(locals.emdash?.db);
	if (dbError) return dbError;
	try {
		const body = await parseBody(request, shopEnrollmentUpdateBody);
		if (isParseError(body)) return body;
		return unwrapResult(
			await handleShopEnrollmentUpdate(
				locals.emdash.db,
				params.id ?? "",
				body.status,
				body.startsAt,
				body.endsAt,
			),
		);
	} catch (error) {
		return handleError(error, "Failed to update open enrollment", "SHOP_ENROLLMENT_UPDATE_ERROR");
	}
};

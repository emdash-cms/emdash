import type { APIRoute } from "astro";

import { handleError, requireDb, unwrapResult } from "#api/error.js";
import { handleShopOrderCreate } from "#api/handlers/shop.js";
import { isParseError, parseBody } from "#api/parse.js";
import { shopOrderCreateBody } from "#api/schemas.js";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals, cookies }) => {
	const dbError = requireDb(locals.emdash?.db);
	if (dbError) return dbError;
	try {
		const body = await parseBody(request, shopOrderCreateBody);
		if (isParseError(body)) return body;
		return unwrapResult(await handleShopOrderCreate(locals.emdash.db, { ...body, cartToken: cookies.get("emdash-shop-cart")?.value }), 201);
	} catch (error) {
		return handleError(error, "Failed to create order", "SHOP_ORDER_CREATE_ERROR");
	}
};

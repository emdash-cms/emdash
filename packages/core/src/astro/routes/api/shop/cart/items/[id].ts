import type { APIRoute } from "astro";

import { handleError, requireDb, unwrapResult } from "#api/error.js";
import { CART_COOKIE, handleShopCartItemDelete, handleShopCartItemUpdate } from "#api/handlers/shop-cart.js";
import { isParseError, parseBody } from "#api/parse.js";
import { shopCartItemUpdateBody } from "#api/schemas.js";

export const prerender = false;

export const DELETE: APIRoute = async ({ cookies, locals, params }) => {
	const dbError = requireDb(locals.emdash?.db);
	if (dbError) return dbError;
	if (!params.id) return new Response(JSON.stringify({ success: false, error: { code: "VALIDATION_ERROR", message: "Item id is required" } }), { status: 400 });
	try {
		return unwrapResult(await handleShopCartItemDelete(locals.emdash.db, { userId: locals.user?.id, guestToken: cookies.get(CART_COOKIE)?.value }, params.id));
	} catch (error) {
		return handleError(error, "Failed to remove cart item", "SHOP_CART_WRITE_ERROR");
	}
};

export const PATCH: APIRoute = async ({ cookies, locals, params, request }) => {
	const dbError = requireDb(locals.emdash?.db);
	if (dbError) return dbError;
	if (!params.id) return new Response(JSON.stringify({ success: false, error: { code: "VALIDATION_ERROR", message: "Item id is required" } }), { status: 400 });
	const body = await parseBody(request, shopCartItemUpdateBody);
	if (isParseError(body)) return body;
	return unwrapResult(await handleShopCartItemUpdate(locals.emdash.db, { userId: locals.user?.id, guestToken: cookies.get(CART_COOKIE)?.value }, params.id, body.quantity));
};

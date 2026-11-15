import type { APIRoute } from "astro";

import { handleError, requireDb, unwrapResult } from "#api/error.js";
import { CART_COOKIE, handleShopCartMerge } from "#api/handlers/shop-cart.js";

export const prerender = false;

export const POST: APIRoute = async ({ cookies, locals }) => {
	const dbError = requireDb(locals.emdash?.db);
	if (dbError) return dbError;
	if (!locals.user?.id) return unwrapResult({ success: false, error: { code: "SHOP_CART_AUTH_REQUIRED", message: "Authenticated user is required" } });
	try {
		return unwrapResult(await handleShopCartMerge(locals.emdash.db, locals.user.id, cookies.get(CART_COOKIE)?.value));
	} catch (error) {
		return handleError(error, "Failed to merge carts", "SHOP_CART_MERGE_ERROR");
	}
};

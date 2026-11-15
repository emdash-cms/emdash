import type { APIRoute } from "astro";

import { handleError, requireDb, unwrapResult } from "#api/error.js";
import { CART_COOKIE, handleShopCartClear, handleShopCartGet, handleShopCartItemCreate } from "#api/handlers/shop-cart.js";
import { isParseError, parseBody } from "#api/parse.js";
import { shopCartItemCreateBody } from "#api/schemas.js";

export const prerender = false;

function identity(cookies: Parameters<APIRoute>[0]["cookies"], userId?: string) {
	return { userId, guestToken: cookies.get(CART_COOKIE)?.value };
}

export const GET: APIRoute = async ({ cookies, locals }) => {
	const dbError = requireDb(locals.emdash?.db);
	if (dbError) return dbError;
	try {
		const result = await handleShopCartGet(locals.emdash.db, identity(cookies, locals.user?.id));
		if (!result.success) return unwrapResult(result);
		if (result.data.guestToken) {
			cookies.set(CART_COOKIE, result.data.guestToken, { httpOnly: true, secure: import.meta.env.PROD, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
		}
		const { guestToken: _guestToken, ...data } = result.data;
		return new Response(JSON.stringify({ success: true, data }), { headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
	} catch (error) {
		return handleError(error, "Failed to read cart", "SHOP_CART_READ_ERROR");
	}
};

export const POST: APIRoute = async ({ request, cookies, locals }) => {
	const dbError = requireDb(locals.emdash?.db);
	if (dbError) return dbError;
	try {
		const body = await parseBody(request, shopCartItemCreateBody);
		if (isParseError(body)) return body;
		const result = await handleShopCartItemCreate(locals.emdash.db, identity(cookies, locals.user?.id), body);
		if (!result.success) return unwrapResult(result);
		if (result.data.guestToken) cookies.set(CART_COOKIE, result.data.guestToken, { httpOnly: true, secure: import.meta.env.PROD, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
		const { guestToken: _guestToken, ...data } = result.data;
		return new Response(JSON.stringify({ success: true, data }), { status: 201, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
	} catch (error) {
		return handleError(error, "Failed to update cart", "SHOP_CART_WRITE_ERROR");
	}
};

export const DELETE: APIRoute = async ({ cookies, locals }) => {
	const dbError = requireDb(locals.emdash?.db);
	if (dbError) return dbError;
	return unwrapResult(await handleShopCartClear(locals.emdash.db, identity(cookies, locals.user?.id)));
};

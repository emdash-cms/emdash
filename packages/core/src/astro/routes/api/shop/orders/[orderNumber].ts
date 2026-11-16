import type { APIRoute } from "astro";

import { requireDb, unwrapResult } from "#api/error.js";
import { handleShopOrderGetByNumber } from "#api/handlers/shop.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, locals, url }) => {
	const dbError = requireDb(locals.emdash?.db);
	if (dbError) return dbError;
	const token = url.searchParams.get("token") ?? "";
	const response = unwrapResult(
		await handleShopOrderGetByNumber(locals.emdash.db, params.orderNumber ?? "", token),
	);
	response.headers.set("Cache-Control", "no-store");
	return response;
};

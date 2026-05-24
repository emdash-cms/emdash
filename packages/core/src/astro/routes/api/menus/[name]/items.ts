/**
 * Menu items create endpoint
 *
 * POST /_emdash/api/menus/:name/items[?locale=xx] - Create a new menu item
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { handleError, unwrapResult } from "#api/error.js";
import { handleMenuItemCreate } from "#api/handlers/menus.js";
import { isParseError, parseBody, parseQuery } from "#api/parse.js";
import { createMenuItemBody, localeFilterQuery } from "#api/schemas.js";

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const name = params.name!;

	const denied = requirePerm(user, "menus:manage");
	if (denied) return denied;

	const localeQ = parseQuery(new URL(request.url), localeFilterQuery);
	if (isParseError(localeQ)) return localeQ;

	try {
		const body = await parseBody(request, createMenuItemBody);
		if (isParseError(body)) return body;

		const result = await handleMenuItemCreate(emdash.db, name, body, { locale: localeQ.locale });
		return unwrapResult(result, 201);
	} catch (error) {
		return handleError(error, "Failed to create menu item", "MENU_ITEM_CREATE_ERROR");
	}
};

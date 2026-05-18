/**
 * Single menu item endpoint
 *
 * PUT    /_emdash/api/menus/:name/items/:id[?locale=xx]
 * DELETE /_emdash/api/menus/:name/items/:id[?locale=xx]
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, handleError, unwrapResult } from "#api/error.js";
import { handleMenuItemDelete, handleMenuItemUpdate } from "#api/handlers/menus.js";
import { isParseError, parseBody, parseQuery } from "#api/parse.js";
import { localeFilterQuery, updateMenuItemBody } from "#api/schemas.js";

export const prerender = false;

export const PUT: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const name = params.name!;
	const itemId = params.id;

	const denied = requirePerm(user, "menus:manage");
	if (denied) return denied;

	if (!itemId) {
		return apiError("VALIDATION_ERROR", "id is required", 400);
	}

	const localeQ = parseQuery(new URL(request.url), localeFilterQuery);
	if (isParseError(localeQ)) return localeQ;

	try {
		const body = await parseBody(request, updateMenuItemBody);
		if (isParseError(body)) return body;

		const result = await handleMenuItemUpdate(emdash.db, name, itemId, body, {
			locale: localeQ.locale,
		});
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to update menu item", "MENU_ITEM_UPDATE_ERROR");
	}
};

export const DELETE: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const name = params.name!;
	const itemId = params.id;

	const denied = requirePerm(user, "menus:manage");
	if (denied) return denied;

	if (!itemId) {
		return apiError("VALIDATION_ERROR", "id is required", 400);
	}

	const localeQ = parseQuery(new URL(request.url), localeFilterQuery);
	if (isParseError(localeQ)) return localeQ;

	try {
		const result = await handleMenuItemDelete(emdash.db, name, itemId, {
			locale: localeQ.locale,
		});
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to delete menu item", "MENU_ITEM_DELETE_ERROR");
	}
};

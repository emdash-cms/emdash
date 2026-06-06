/**
 * Menu items reorder endpoint
 *
 * POST /_emdash/api/menus/:name/reorder - Batch update positions
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { handleError, unwrapResult } from "#api/error.js";
import { handleMenuItemReorder } from "#api/handlers/menus.js";
import { isParseError, parseBody, parseQuery } from "#api/parse.js";
import { localeFilterQuery, reorderMenuItemsBody } from "#api/schemas.js";

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const name = params.name!;

	const denied = requirePerm(user, "menus:manage");
	if (denied) return denied;

	const localeQ = parseQuery(new URL(request.url), localeFilterQuery);
	if (isParseError(localeQ)) return localeQ;

	try {
		const body = await parseBody(request, reorderMenuItemsBody);
		if (isParseError(body)) return body;

		const result = await handleMenuItemReorder(emdash.db, name, body.items, {
			locale: localeQ.locale,
		});
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to reorder menu items", "MENU_REORDER_ERROR");
	}
};

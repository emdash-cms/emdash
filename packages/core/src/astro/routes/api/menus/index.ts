/**
 * Menus list and create endpoints
 *
 * GET  /_emdash/api/menus[?locale=xx] - List menus (optionally filtered by locale)
 * POST /_emdash/api/menus              - Create menu (body may include locale & translationOf)
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { handleError, unwrapResult } from "#api/error.js";
import { handleMenuCreate, handleMenuList } from "#api/handlers/menus.js";
import { isParseError, parseBody, parseQuery } from "#api/parse.js";
import { createMenuBody, localeFilterQuery } from "#api/schemas.js";

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	const denied = requirePerm(user, "menus:read");
	if (denied) return denied;

	const query = parseQuery(new URL(request.url), localeFilterQuery);
	if (isParseError(query)) return query;

	try {
		const result = await handleMenuList(emdash.db, { locale: query.locale });
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to fetch menus", "MENU_LIST_ERROR");
	}
};

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	const denied = requirePerm(user, "menus:manage");
	if (denied) return denied;

	try {
		const body = await parseBody(request, createMenuBody);
		if (isParseError(body)) return body;

		const result = await handleMenuCreate(emdash.db, body);
		return unwrapResult(result, 201);
	} catch (error) {
		return handleError(error, "Failed to create menu", "MENU_CREATE_ERROR");
	}
};

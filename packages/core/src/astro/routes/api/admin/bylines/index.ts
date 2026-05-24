import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError, unwrapResult } from "#api/error.js";
import { handleBylineCreate } from "#api/handlers/bylines.js";
import { isParseError, parseBody, parseQuery } from "#api/parse.js";
import { bylineCreateBody, bylinesListQuery } from "#api/schemas.js";
import { invalidateBylineCache } from "#bylines/index.js";
import { BylineRepository } from "#db/repositories/byline.js";

import { getI18nConfig } from "../../../../../i18n/config.js";

export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "bylines:read");
	if (denied) return denied;

	const query = parseQuery(url, bylinesListQuery);
	if (isParseError(query)) return query;

	const i18n = getI18nConfig();
	if (query.locale && i18n && !i18n.locales.includes(query.locale)) {
		return apiError(
			"VALIDATION_ERROR",
			`Locale "${query.locale}" is not configured for this site`,
			400,
		);
	}

	try {
		const repo = new BylineRepository(emdash.db);
		const result = await repo.findMany({
			search: query.search,
			isGuest: query.isGuest,
			userId: query.userId,
			locale: query.locale,
			cursor: query.cursor,
			limit: query.limit,
		});

		return apiSuccess(result);
	} catch (error) {
		return handleError(error, "Failed to list bylines", "BYLINE_LIST_ERROR");
	}
};

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "bylines:manage");
	if (denied) return denied;

	const body = await parseBody(request, bylineCreateBody);
	if (isParseError(body)) return body;

	try {
		const result = await handleBylineCreate(emdash.db, {
			slug: body.slug,
			displayName: body.displayName,
			bio: body.bio ?? null,
			avatarMediaId: body.avatarMediaId ?? null,
			websiteUrl: body.websiteUrl ?? null,
			userId: body.userId ?? null,
			isGuest: body.isGuest,
			locale: body.locale,
			translationOf: body.translationOf,
		});

		if (result.success) invalidateBylineCache();
		return unwrapResult(result, 201);
	} catch (error) {
		return handleError(error, "Failed to create byline", "BYLINE_CREATE_ERROR");
	}
};

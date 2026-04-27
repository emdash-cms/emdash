import { Role } from "@emdash-cms/auth";
import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody, parseQuery } from "#api/parse.js";
import { bylineCreateBody, bylinesListQuery } from "#api/schemas.js";
import { invalidateBylineCache } from "#bylines/index.js";
import { BylineRepository } from "#db/repositories/byline.js";

export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	// Read access uses content:read so all authenticated roles can view byline data
	const denied = requirePerm(user, "content:read");
	if (denied) return denied;

	const query = parseQuery(url, bylinesListQuery);
	if (isParseError(query)) return query;

	try {
		const repo = new BylineRepository(emdash.db);
		const result = await repo.findMany({
			search: query.search,
			isGuest: query.isGuest,
			userId: query.userId,
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

	if (!user || user.role < Role.EDITOR) {
		return apiError("FORBIDDEN", "Editor privileges required", 403);
	}

	const body = await parseBody(request, bylineCreateBody);
	if (isParseError(body)) return body;

	try {
		const repo = new BylineRepository(emdash.db);
		const byline = await repo.create({
			slug: body.slug,
			displayName: body.displayName,
			bio: body.bio ?? null,
			avatarMediaId: body.avatarMediaId ?? null,
			websiteUrl: body.websiteUrl ?? null,
			userId: body.userId ?? null,
			isGuest: body.isGuest,
		});

		invalidateBylineCache();
		return apiSuccess(byline, 201);
	} catch (error) {
		return handleError(error, "Failed to create byline", "BYLINE_CREATE_ERROR");
	}
};

import { Role } from "@emdash-cms/auth";
import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { bylineUpdateBody } from "#api/schemas.js";
import { invalidateBylineCache } from "#bylines/index.js";
import { BylineRepository } from "#db/repositories/byline.js";

export const prerender = false;

function requireEditor(user: { role: number } | undefined): Response | null {
	if (!user || user.role < Role.EDITOR) {
		return apiError("FORBIDDEN", "Editor privileges required", 403);
	}
	return null;
}

export const GET: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	// Read access uses content:read so all authenticated roles can view byline data
	const denied = requirePerm(user, "content:read");
	if (denied) return denied;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	try {
		const repo = new BylineRepository(emdash.db);
		const byline = await repo.findById(params.id!);
		if (!byline) return apiError("NOT_FOUND", "Byline not found", 404);
		return apiSuccess(byline);
	} catch (error) {
		return handleError(error, "Failed to get byline", "BYLINE_GET_ERROR");
	}
};

export const PUT: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const denied = requireEditor(user);
	if (denied) return denied;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const body = await parseBody(request, bylineUpdateBody);
	if (isParseError(body)) return body;

	try {
		const repo = new BylineRepository(emdash.db);
		const byline = await repo.update(params.id!, {
			slug: body.slug,
			displayName: body.displayName,
			bio: body.bio ?? null,
			avatarMediaId: body.avatarMediaId ?? null,
			websiteUrl: body.websiteUrl ?? null,
			userId: body.userId ?? null,
			isGuest: body.isGuest,
		});

		if (!byline) return apiError("NOT_FOUND", "Byline not found", 404);
		invalidateBylineCache();
		return apiSuccess(byline);
	} catch (error) {
		return handleError(error, "Failed to update byline", "BYLINE_UPDATE_ERROR");
	}
};

export const DELETE: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const denied = requireEditor(user);
	if (denied) return denied;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	try {
		const repo = new BylineRepository(emdash.db);
		const deleted = await repo.delete(params.id!);
		if (!deleted) return apiError("NOT_FOUND", "Byline not found", 404);
		invalidateBylineCache();
		return apiSuccess({ deleted: true });
	} catch (error) {
		return handleError(error, "Failed to delete byline", "BYLINE_DELETE_ERROR");
	}
};

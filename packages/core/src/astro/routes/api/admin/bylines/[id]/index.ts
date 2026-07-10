import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError, requireDb, unwrapResult } from "#api/error.js";
import { handleBylineUpdate } from "#api/handlers/bylines.js";
import { isParseError, parseBody } from "#api/parse.js";
import { bylineUpdateBody } from "#api/schemas.js";
import { invalidateBylineCache } from "#bylines/index.js";
import { BylineRepository } from "#db/repositories/byline.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const denied = requirePerm(user, "bylines:read");
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
	const denied = requirePerm(user, "bylines:manage");
	if (denied) return denied;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const body = await parseBody(request, bylineUpdateBody);
	if (isParseError(body)) return body;

	const result = await handleBylineUpdate(emdash.db, params.id!, {
		slug: body.slug,
		displayName: body.displayName,
		bio: body.bio ?? null,
		avatarMediaId: body.avatarMediaId ?? null,
		websiteUrl: body.websiteUrl ?? null,
		userId: body.userId ?? null,
		isGuest: body.isGuest,
		// Forward `customFields` only when present so the repo treats an
		// omitted key as "leave existing values untouched". An empty
		// object also no-ops by repo convention — see
		// `BylineRepository.update`. Validation (unknown slug, type
		// mismatch, select-choice) happens inside the repo and surfaces
		// as `EmDashValidationError`, which the handler maps to a 400
		// `VALIDATION_ERROR` for `unwrapResult` / `mapErrorStatus`.
		customFields: body.customFields,
	});

	if (result.success) invalidateBylineCache();
	return unwrapResult(result);
};

export const DELETE: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const denied = requirePerm(user, "bylines:manage");
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

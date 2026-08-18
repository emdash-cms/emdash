/**
 * Relation translations endpoint
 *
 * GET /_emdash/api/relations/:id/translations - List locale siblings of a relation
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, handleError, requireDb, unwrapResult } from "#api/error.js";
import { handleRelationTranslations } from "#api/handlers/relations.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const { id } = params;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "schema:read");
	if (denied) return denied;

	if (!id) return apiError("VALIDATION_ERROR", "Relation id required", 400);

	try {
		const result = await handleRelationTranslations(emdash.db, id);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to get translations", "RELATION_TRANSLATIONS_ERROR");
	}
};

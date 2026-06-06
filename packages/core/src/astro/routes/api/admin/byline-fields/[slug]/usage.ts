/**
 * Byline field usage counts.
 *
 * GET /_emdash/api/admin/byline-fields/{slug}/usage
 *
 * Returns `{ translatableValueCount, groupValueCount, totalAffectedRows }`.
 * Backs the destructive-delete confirm dialog in the admin UI (Phase 5).
 * Thin wrapper around `handleBylineFieldUsage`.
 *
 * Phase 4 of Discussion #1174.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, requireDb, unwrapResult } from "#api/error.js";
import { handleBylineFieldUsage } from "#api/handlers/byline-fields.js";

export const prerender = false;

// GET requires `schema:read` (Editor+); see byline-fields/index.ts GET
// for rationale on the read/manage split.
export const GET: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const denied = requirePerm(user, "schema:read");
	if (denied) return denied;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const slug = params.slug;
	if (!slug) return apiError("MISSING_PARAM", "Field slug is required", 400);

	const result = await handleBylineFieldUsage(emdash.db, slug);
	return unwrapResult(result);
};

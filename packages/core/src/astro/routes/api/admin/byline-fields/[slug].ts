/**
 * Byline custom-field schema management — single field CRUD.
 *
 * - GET    /_emdash/api/admin/byline-fields/{slug}    read one definition
 * - PATCH  /_emdash/api/admin/byline-fields/{slug}    update label / required /
 *                                                     translatable / validation /
 *                                                     sort order
 * - DELETE /_emdash/api/admin/byline-fields/{slug}    drop the definition and all
 *                                                     stored values (FK CASCADE +
 *                                                     app-level cleanup; see
 *                                                     `BylineSchemaRegistry.deleteField`)
 *
 * Thin wrappers around the handler layer; status mapping happens in
 * `unwrapResult`. `slug` and `type` are immutable post-create — see
 * `bylineFieldUpdateBody`. Flipping `translatable` while value rows
 * exist surfaces as a 409 `TRANSLATABLE_LOCKED`.
 *
 * Phase 4 of Discussion #1174.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, requireDb, unwrapResult } from "#api/error.js";
import {
	handleBylineFieldDelete,
	handleBylineFieldGet,
	handleBylineFieldUpdate,
} from "#api/handlers/byline-fields.js";
import { isParseError, parseBody } from "#api/parse.js";
import { bylineFieldUpdateBody } from "#api/schemas.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const denied = requirePerm(user, "schema:manage");
	if (denied) return denied;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const slug = params.slug;
	if (!slug) return apiError("MISSING_PARAM", "Field slug is required", 400);

	const result = await handleBylineFieldGet(emdash.db, slug);
	return unwrapResult(result);
};

export const PATCH: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const denied = requirePerm(user, "schema:manage");
	if (denied) return denied;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const slug = params.slug;
	if (!slug) return apiError("MISSING_PARAM", "Field slug is required", 400);

	const body = await parseBody(request, bylineFieldUpdateBody);
	if (isParseError(body)) return body;

	const result = await handleBylineFieldUpdate(emdash.db, slug, {
		label: body.label,
		required: body.required,
		translatable: body.translatable,
		// `null` clears the stored validation; `undefined` leaves it as-is.
		// The zod schema makes `validation` itself optional, so an absent
		// key reaches the handler as `undefined`.
		validation: body.validation,
		sortOrder: body.sortOrder,
	});
	return unwrapResult(result);
};

export const DELETE: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const denied = requirePerm(user, "schema:manage");
	if (denied) return denied;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const slug = params.slug;
	if (!slug) return apiError("MISSING_PARAM", "Field slug is required", 400);

	const result = await handleBylineFieldDelete(emdash.db, slug);
	return unwrapResult(result);
};

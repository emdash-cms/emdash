/**
 * Schema collections list and create endpoints
 *
 * GET  /_emdash/api/schema/collections - List collections
 * POST /_emdash/api/schema/collections - Create collection
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { requireDb, unwrapResult } from "#api/error.js";
import { handleSchemaCollectionList, handleSchemaCollectionCreate } from "#api/index.js";
import { parseBody, isParseError } from "#api/parse.js";
import { createCollectionBody } from "#api/schemas.js";
import type { CreateCollectionInput } from "#schema/types.js";

import { invalidateUrlPatternCache } from "../../../../query.js";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
	const { emdash, user } = locals;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "schema:read");
	if (denied) return denied;

	const result = await handleSchemaCollectionList(emdash!.db);
	return unwrapResult(result);
};

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "schema:manage");
	if (denied) return denied;

	const body = await parseBody(request, createCollectionBody);
	if (isParseError(body)) return body;

	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- Zod schema output narrowed to CreateCollectionInput
	const result = await handleSchemaCollectionCreate(emdash!.db, body as CreateCollectionInput);
	invalidateUrlPatternCache();
	return unwrapResult(result, 201);
};

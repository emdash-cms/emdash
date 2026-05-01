/**
 * Schema field reorder endpoint
 *
 * POST /_emdash/api/schema/collections/{slug}/fields/reorder - Reorder fields
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { requireDb, unwrapResult } from "#api/error.js";
import { handleSchemaFieldReorder } from "#api/index.js";
import { parseBody, isParseError } from "#api/parse.js";
import { fieldReorderBody } from "#api/schemas.js";

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const collectionSlug = params.slug!;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "schema:manage");
	if (denied) return denied;

	const body = await parseBody(request, fieldReorderBody);
	if (isParseError(body)) return body;

	const result = await handleSchemaFieldReorder(emdash!.db, collectionSlug, body.fieldSlugs);
	return unwrapResult(result);
};

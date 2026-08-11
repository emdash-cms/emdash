/**
 * Collection reorder endpoint
 *
 * POST /_emdash/api/schema/collections/reorder - Set the admin sidebar order
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { requireDb, unwrapResult } from "#api/error.js";
import { handleSchemaCollectionReorder } from "#api/index.js";
import { parseBody, isParseError } from "#api/parse.js";
import { collectionReorderBody } from "#api/schemas.js";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "schema:manage");
	if (denied) return denied;

	const body = await parseBody(request, collectionReorderBody);
	if (isParseError(body)) return body;

	const result = await handleSchemaCollectionReorder(emdash.db, body.slugs);
	return unwrapResult(result);
};

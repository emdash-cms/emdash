/**
 * Schema collection menu sync endpoint
 *
 * POST /_emdash/api/schema/collections/:slug/sync-menu
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { requireDb, unwrapResult } from "#api/error.js";
import { handleSchemaCollectionMenuSync } from "#api/index.js";
import { parseBody, isParseError } from "#api/parse.js";
import { z } from "zod";

export const prerender = false;

const syncBody = z.object({
	menuName: z.string().min(1),
});

export const POST: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const slug = params.slug;

	if (!slug) {
		return unwrapResult({
			success: false,
			error: { code: "MISSING_PARAM", message: "Collection slug is required" },
		});
	}

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "schema:manage");
	if (denied) return denied;

	const body = await parseBody(request, syncBody);
	if (isParseError(body)) return body;

	const result = await handleSchemaCollectionMenuSync(emdash!.db, slug, body.menuName);
	return unwrapResult(result);
};

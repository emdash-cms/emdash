/**
 * Schema collection menu sync endpoint
 *
 * POST /_emdash/api/schema/collections/:slug/sync-menu
 */

import type { APIRoute } from "astro";
import { z } from "zod";

import { requirePerm } from "#api/authorize.js";
import { requireDb, unwrapResult } from "#api/error.js";
import { handleSchemaCollectionMenuSync } from "#api/index.js";
import { parseBody, isParseError, parseQuery } from "#api/parse.js";
import { localeFilterQuery } from "#api/schemas.js";

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

	const localeQ = parseQuery(new URL(request.url), localeFilterQuery);
	if (isParseError(localeQ)) return localeQ;

	const body = await parseBody(request, syncBody);
	if (isParseError(body)) return body;

	const result = await handleSchemaCollectionMenuSync(
		emdash!.db,
		slug,
		body.menuName,
		localeQ.locale,
	);
	return unwrapResult(result);
};

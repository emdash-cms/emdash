/**
 * Schema collections reorder endpoint
 *
 * POST /_emdash/api/schema/collections/reorder
 */

import type { APIRoute } from "astro";
import { z } from "zod";

import { requirePerm } from "#api/authorize.js";
import { requireDb, unwrapResult } from "#api/error.js";
import { handleSchemaCollectionReorder } from "#api/index.js";
import { parseBody, isParseError } from "#api/parse.js";

export const prerender = false;

const reorderBody = z.object({
	collections: z
		.array(
			z.object({
				slug: z.string().min(1),
				sortOrder: z.number().int().min(0),
			}),
		)
		.min(1)
		.max(200),
});

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "schema:manage");
	if (denied) return denied;

	const body = await parseBody(request, reorderBody);
	if (isParseError(body)) return body;

	const result = await handleSchemaCollectionReorder(emdash!.db, body.collections);
	// Manifest is built fresh per-request via requestCached, so no cache invalidation needed.
	// The next admin request will see the updated sort_order values.
	return unwrapResult(result);
};

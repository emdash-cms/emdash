/**
 * Workers Cache status + purge endpoint
 *
 * GET  /_emdash/api/admin/cache/workers — whether native purge is available
 * POST /_emdash/api/admin/cache/workers — purgeEverything or pathPrefixes
 */

import type { APIRoute } from "astro";
import { z } from "zod";

import { requirePerm } from "#api/authorize.js";
import { handleWorkersCachePurge, handleWorkersCacheStatus } from "#api/handlers/workers-cache.js";
import { unwrapResult } from "#api/index.js";
import { isParseError, parseOptionalBody } from "#api/parse.js";

export const prerender = false;

const purgeBody = z.object({
	pathPrefixes: z.array(z.string().min(1).max(2048)).max(50).optional(),
});

export const GET: APIRoute = async ({ locals }) => {
	const { user } = locals;

	const denied = requirePerm(user, "settings:manage");
	if (denied) return denied;

	const result = await handleWorkersCacheStatus();
	return unwrapResult(result);
};

export const POST: APIRoute = async ({ request, locals }) => {
	const { user } = locals;

	const denied = requirePerm(user, "settings:manage");
	if (denied) return denied;

	const body = await parseOptionalBody(request, purgeBody, {});
	if (isParseError(body)) return body;

	const result = await handleWorkersCachePurge({
		pathPrefixes: body?.pathPrefixes,
	});
	return unwrapResult(result);
};

/**
 * Object-cache status + purge endpoint
 *
 * GET  /_emdash/api/admin/cache/object — whether a backend is configured
 * POST /_emdash/api/admin/cache/object — bump epochs for CMS object-cache namespaces
 */

import type { APIRoute } from "astro";
import { z } from "zod";

import { requirePerm } from "#api/authorize.js";
import { apiError } from "#api/error.js";
import { handleObjectCachePurge, handleObjectCacheStatus } from "#api/handlers/object-cache.js";
import { unwrapResult } from "#api/index.js";
import { isParseError, parseBody } from "#api/parse.js";

export const prerender = false;

const purgeBody = z
	.object({
		namespaces: z.array(z.string().min(1).max(128)).max(200).optional(),
	})
	.default({});

export const GET: APIRoute = async ({ locals }) => {
	const { user } = locals;

	const denied = requirePerm(user, "settings:manage");
	if (denied) return denied;

	const result = await handleObjectCacheStatus();
	return unwrapResult(result);
};

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "settings:manage");
	if (denied) return denied;

	const body = await parseBody(request, purgeBody);
	if (isParseError(body)) return body;

	const result = await handleObjectCachePurge(emdash.db, body);
	return unwrapResult(result);
};

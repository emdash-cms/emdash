/**
 * Workers Cache status + purge endpoint
 *
 * GET  /_emdash/api/admin/cache/workers — whether purge credentials are configured
 * POST /_emdash/api/admin/cache/workers — purge_everything via Cloudflare API
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { handleWorkersCachePurge, handleWorkersCacheStatus } from "#api/handlers/workers-cache.js";
import { unwrapResult } from "#api/index.js";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
	const { user } = locals;

	const denied = requirePerm(user, "settings:manage");
	if (denied) return denied;

	const result = await handleWorkersCacheStatus();
	return unwrapResult(result);
};

export const POST: APIRoute = async ({ locals }) => {
	const { user } = locals;

	const denied = requirePerm(user, "settings:manage");
	if (denied) return denied;

	const result = await handleWorkersCachePurge();
	return unwrapResult(result);
};

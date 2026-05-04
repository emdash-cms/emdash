/**
 * Single revision endpoint - injected by EmDash integration
 *
 * GET  /_emdash/api/revisions/{revisionId} - Get revision details
 * POST /_emdash/api/revisions/{revisionId}/restore - Restore revision
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const revisionId = params.revisionId!;

	const denied = requirePerm(user, "content:read_drafts");
	if (denied) return denied;

	if (!emdash?.handleRevisionGet) {
		return apiError("NOT_CONFIGURED", "EmDash not configured", 500);
	}

	const result = await emdash.handleRevisionGet(revisionId);

	return unwrapResult(result);
};

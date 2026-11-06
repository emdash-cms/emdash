/**
 * Plugin enable endpoint
 *
 * POST /_emdash/api/admin/plugins/:id/enable - Enable a plugin
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import { enableRuntimePlugin } from "#plugins/lifecycle.js";

import { checkSiteWriteFence } from "../../../../../../transfer/fence.js";

export const prerender = false;

export const POST: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const { id } = params;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "plugins:manage");
	if (denied) return denied;

	const writeFence = await checkSiteWriteFence(emdash.db);
	if (writeFence) return writeFence;

	if (!id) {
		return apiError("INVALID_REQUEST", "Plugin ID required", 400);
	}

	return unwrapResult(await enableRuntimePlugin(emdash, id));
};

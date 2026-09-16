/**
 * Plugin disable endpoint
 *
 * POST /_emdash/api/admin/plugins/:id/disable - Disable a plugin
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import { checkMediaUsageActivationWriteFence } from "#api/media-usage-write-fence.js";
import { disableRuntimePlugin } from "#plugins/lifecycle.js";

export const prerender = false;

export const POST: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const { id } = params;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "plugins:manage");
	if (denied) return denied;

	const activationFence = await checkMediaUsageActivationWriteFence(emdash.db);
	if (activationFence) return activationFence;

	if (!id) {
		return apiError("INVALID_REQUEST", "Plugin ID required", 400);
	}

	return unwrapResult(await disableRuntimePlugin(emdash, id));
};

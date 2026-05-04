/**
 * Marketplace plugin update endpoint
 *
 * POST /_emdash/api/admin/plugins/:id/update - Update a marketplace plugin
 */

import type { APIRoute } from "astro";
import { z } from "zod";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import { handleMarketplaceUpdate } from "#api/index.js";
import { isParseError, parseOptionalBody } from "#api/parse.js";

export const prerender = false;

const updateBodySchema = z.object({
	version: z.string().min(1).optional(),
	confirmCapabilityChanges: z.boolean().optional(),
	confirmRouteVisibilityChanges: z.boolean().optional(),
});

export const POST: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const { id } = params;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "plugins:manage");
	if (denied) return denied;

	if (!id) {
		return apiError("INVALID_REQUEST", "Plugin ID required", 400);
	}

	const body = await parseOptionalBody(request, updateBodySchema, {});
	if (isParseError(body)) return body;

	const result = await handleMarketplaceUpdate(
		emdash.db,
		emdash.storage,
		emdash.getSandboxRunner(),
		emdash.config.marketplace,
		id,
		{
			version: body.version,
			confirmCapabilityChanges: body.confirmCapabilityChanges,
			confirmRouteVisibilityChanges: body.confirmRouteVisibilityChanges,
			sandboxBypassed: emdash.isSandboxBypassed(),
		},
	);

	if (!result.success) return unwrapResult(result);

	await emdash.syncMarketplacePlugins();

	return unwrapResult(result);
};

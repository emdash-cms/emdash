/**
 * Marketplace plugin uninstall endpoint
 *
 * POST /_emdash/api/admin/plugins/:id/uninstall - Uninstall a marketplace plugin
 */

import type { APIRoute } from "astro";
import { z } from "zod";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import { handleMarketplaceUninstall } from "#api/index.js";
import { checkMediaUsageActivationWriteFence } from "#api/media-usage-write-fence.js";
import { isParseError, parseOptionalBody } from "#api/parse.js";

export const prerender = false;

const uninstallBodySchema = z.object({
	deleteData: z.boolean().optional(),
});

export const POST: APIRoute = async ({ params, request, locals }) => {
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

	const body = await parseOptionalBody(request, uninstallBodySchema, {});
	if (isParseError(body)) return body;

	const result = await handleMarketplaceUninstall(emdash.db, emdash.storage, id, {
		deleteData: body.deleteData ?? false,
	});

	if (!result.success) return unwrapResult(result);

	await emdash.syncMarketplacePlugins();

	return unwrapResult(result);
};

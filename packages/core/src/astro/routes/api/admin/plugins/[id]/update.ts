/**
 * Marketplace plugin update endpoint
 *
 * POST /_emdash/api/admin/plugins/:id/update - Update a marketplace plugin
 */

import type { APIRoute } from "astro";
import { z } from "zod";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import { handleMarketplaceUpdate, rollbackPluginUpdate } from "#api/index.js";
import { checkMediaUsageActivationWriteFence } from "#api/media-usage-write-fence.js";
import { isParseError, parseOptionalBody } from "#api/parse.js";
import { finalizePluginUpdate } from "#plugins/install-finalization.js";
import { pluginPublicRouteAcknowledgementSchema } from "#plugins/routes.js";
import { PluginStateRepository } from "#plugins/state.js";

export const prerender = false;

const updateBodySchema = z.object({
	version: z.string().min(1).optional(),
	confirmCapabilityChanges: z.boolean().optional(),
	acknowledgedPublicRoutes: pluginPublicRouteAcknowledgementSchema.optional(),
	confirmMcpTools: z.boolean().optional(),
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

	const body = await parseOptionalBody(request, updateBodySchema, {});
	if (isParseError(body)) return body;
	const previousState = await new PluginStateRepository(emdash.db).get(id);

	const result = await handleMarketplaceUpdate(
		emdash.db,
		emdash.storage,
		emdash.getSandboxRunner(),
		emdash.config.marketplace,
		id,
		{
			version: body.version,
			confirmCapabilityChanges: body.confirmCapabilityChanges,
			acknowledgedPublicRoutes: body.acknowledgedPublicRoutes,
			confirmMcpTools: body.confirmMcpTools,
			sandboxBypassed: emdash.isSandboxBypassed(),
		},
	);

	if (!result.success) return unwrapResult(result);
	if (!previousState) return apiError("UPDATE_FAILED", "Failed to update plugin", 500);

	await finalizePluginUpdate({
		pluginId: id,
		syncRuntime: () => emdash.syncMarketplacePlugins(),
		runLifecycle: () => emdash.runPluginActivateLifecycle(id),
		rollback: () =>
			rollbackPluginUpdate(
				emdash.db,
				emdash.storage,
				previousState,
				result.data.newVersion,
				"marketplace",
			),
		runRollbackLifecycle: () =>
			previousState.status === "active" ? emdash.runPluginActivateLifecycle(id) : Promise.resolve(),
	});

	return unwrapResult(result);
};

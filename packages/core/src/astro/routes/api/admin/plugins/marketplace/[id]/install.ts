/**
 * Marketplace plugin install endpoint
 *
 * POST /_emdash/api/admin/plugins/marketplace/:id/install - Install a marketplace plugin
 */

import type { APIRoute } from "astro";
import { z } from "zod";

import { requirePerm } from "#api/authorize.js";
import { apiError, handleError, unwrapResult } from "#api/error.js";
import { handleMarketplaceInstall, handleMarketplaceUninstall } from "#api/index.js";
import { isParseError, parseOptionalBody } from "#api/parse.js";
import { finalizePluginInstall } from "#plugins/install-finalization.js";
import { pluginPublicRouteAcknowledgementSchema } from "#plugins/routes.js";

import { checkSiteWriteFence } from "../../../../../../../transfer/fence.js";

export const prerender = false;

const installBodySchema = z.object({
	version: z.string().min(1).optional(),
	confirmMcpTools: z.boolean().optional(),
	acknowledgedPublicRoutes: pluginPublicRouteAcknowledgementSchema.optional(),
});

export const POST: APIRoute = async ({ params, request, locals }) => {
	try {
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

		const body = await parseOptionalBody(request, installBodySchema, {});
		if (isParseError(body)) return body;

		const configuredPluginIds = new Set<string>(
			emdash.configuredPlugins.map((p: { id: string }) => p.id),
		);

		const siteOrigin = new URL(request.url).origin;

		const result = await handleMarketplaceInstall(
			emdash.db,
			emdash.storage,
			emdash.getSandboxRunner(),
			emdash.config.marketplace,
			id,
			{
				version: body.version,
				configuredPluginIds,
				siteOrigin,
				sandboxBypassed: emdash.isSandboxBypassed(),
				confirmMcpTools: body.confirmMcpTools,
				acknowledgedPublicRoutes: body.acknowledgedPublicRoutes,
			},
		);

		if (!result.success) return unwrapResult(result);

		await finalizePluginInstall({
			pluginId: id,
			syncRuntime: () => emdash.syncMarketplacePlugins(),
			runLifecycle: () => emdash.runPluginInstallLifecycle(id),
			rollback: () =>
				handleMarketplaceUninstall(emdash.db, emdash.storage, id, { deleteData: true }),
		});

		return unwrapResult(result, 201);
	} catch (error) {
		console.error("[marketplace-install] Unhandled error:", error);
		return handleError(error, "Failed to install plugin from marketplace", "INSTALL_FAILED");
	}
};

/**
 * Marketplace plugin install endpoint
 *
 * POST /_emdash/api/admin/plugins/marketplace/:id/install - Install a marketplace plugin
 */

import type { APIRoute } from "astro";
import { z } from "zod";

import { requirePerm } from "#api/authorize.js";
import { apiError, handleError, unwrapResult } from "#api/error.js";
import { handleMarketplaceInstall } from "#api/index.js";
import { isParseError, parseOptionalBody } from "#api/parse.js";

export const prerender = false;

const installBodySchema = z.object({
	version: z.string().min(1).optional(),
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
			},
		);

		if (!result.success) return unwrapResult(result);

		await emdash.syncMarketplacePlugins();

		return unwrapResult(result, 201);
	} catch (error) {
		console.error("[marketplace-install] Unhandled error:", error);
		return handleError(error, "Failed to install plugin from marketplace", "INSTALL_FAILED");
	}
};

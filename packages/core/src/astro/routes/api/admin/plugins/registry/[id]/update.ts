/**
 * Registry plugin update endpoint (experimental)
 *
 * POST /_emdash/api/admin/plugins/registry/:id/update — Update a
 * registry-source plugin to a newer release. Mirrors the marketplace
 * update route's escalation gates: `CAPABILITY_ESCALATION` if the new
 * version declares new capabilities and `confirmCapabilityChanges` is
 * absent, and `ROUTE_VISIBILITY_ESCALATION` if it newly exposes public
 * routes and `confirmRouteVisibilityChanges` is absent.
 */

import type { APIRoute } from "astro";
import { z } from "zod";

import { requirePerm } from "#api/authorize.js";
import { apiError, handleError, unwrapResult } from "#api/error.js";
import { buildHostEnv, handleRegistryUpdate } from "#api/index.js";
import { isParseError, parseOptionalBody } from "#api/parse.js";

import { VERSION } from "../../../../../../../version.js";

export const prerender = false;

const updateBodySchema = z.object({
	/** Optional explicit target version. Defaults to the aggregator's latest. */
	version: z.string().min(1).max(64).optional(),
	/**
	 * Set by the admin's capability re-consent dialog when the new version
	 * declares capabilities the installed version did not. Without this,
	 * the handler returns `CAPABILITY_ESCALATION` carrying the diff.
	 */
	confirmCapabilityChanges: z.boolean().optional(),
	/**
	 * Set by the admin's route-visibility re-consent dialog when the new
	 * version newly exposes a public (unauthenticated) route.
	 */
	confirmRouteVisibilityChanges: z.boolean().optional(),
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

		const body = await parseOptionalBody(request, updateBodySchema, {});
		if (isParseError(body)) return body;

		const result = await handleRegistryUpdate(
			emdash.db,
			emdash.storage,
			emdash.getSandboxRunner(),
			emdash.config.experimental?.registry,
			id,
			{
				version: body.version,
				confirmCapabilityChanges: body.confirmCapabilityChanges,
				confirmRouteVisibilityChanges: body.confirmRouteVisibilityChanges,
				hostEnv: buildHostEnv(VERSION, emdash.config.astroVersion),
			},
		);

		if (!result.success) return unwrapResult(result);

		await emdash.syncRegistryPlugins();

		return unwrapResult(result);
	} catch (error) {
		console.error("[registry-update] Unhandled error:", error);
		return handleError(error, "Failed to update plugin from registry", "UPDATE_FAILED");
	}
};

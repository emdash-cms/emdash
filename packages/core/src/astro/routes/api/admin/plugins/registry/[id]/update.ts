/**
 * Registry plugin update endpoint (experimental)
 *
 * POST /_emdash/api/admin/plugins/registry/:id/update — Update a
 * registry-source plugin to a newer release. Mirrors the marketplace
 * update route's escalation gates: `CAPABILITY_ESCALATION` if the new
 * version declares new capabilities and `confirmCapabilityChanges` is
 * absent, and `ROUTE_VISIBILITY_ESCALATION` if it newly exposes public
 * routes and `acknowledgedPublicRoutes` does not exactly match them.
 */

import { hostEnvFromVersions } from "@emdash-cms/registry-client/env";
import type { APIRoute } from "astro";
import { z } from "zod";

import { requirePerm } from "#api/authorize.js";
import { apiError, handleError, unwrapResult } from "#api/error.js";
import { handleRegistryUpdate, rollbackPluginUpdate } from "#api/index.js";
import { isParseError, parseOptionalBody } from "#api/parse.js";
import { finalizePluginUpdate } from "#plugins/install-finalization.js";
import { pluginPublicRouteAcknowledgementSchema } from "#plugins/routes.js";
import { PluginStateRepository } from "#plugins/state.js";

import { getRegistryConfigInput } from "../../../../../../../registry/config.js";
import { checkSiteWriteFence } from "../../../../../../../transfer/fence.js";
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
	/** Exact newly public route names reviewed by the admin. */
	acknowledgedPublicRoutes: pluginPublicRouteAcknowledgementSchema.optional(),
	confirmMcpTools: z.boolean().optional(),
	acknowledgedProfileCid: z.string().min(1).max(256).optional(),
	acknowledgedReleaseCid: z.string().min(1).max(256).optional(),
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

		const body = await parseOptionalBody(request, updateBodySchema, {});
		if (isParseError(body)) return body;
		const previousState = await new PluginStateRepository(emdash.db).get(id);

		const result = await handleRegistryUpdate(
			emdash.db,
			emdash.storage,
			emdash.getSandboxRunner(),
			getRegistryConfigInput(emdash.config.registry, emdash.config.experimental?.registry),
			id,
			{
				version: body.version,
				confirmCapabilityChanges: body.confirmCapabilityChanges,
				acknowledgedPublicRoutes: body.acknowledgedPublicRoutes,
				confirmMcpTools: body.confirmMcpTools,
				acknowledgedProfileCid: body.acknowledgedProfileCid,
				acknowledgedReleaseCid: body.acknowledgedReleaseCid,
				hostEnv: hostEnvFromVersions(VERSION, emdash.config.astroVersion),
			},
		);

		if (!result.success) return unwrapResult(result);
		if (!previousState) return apiError("UPDATE_FAILED", "Failed to update plugin", 500);

		await finalizePluginUpdate({
			pluginId: id,
			syncRuntime: () => emdash.syncRegistryPlugins(),
			runLifecycle: () => emdash.runPluginActivateLifecycle(id),
			rollback: () =>
				rollbackPluginUpdate(
					emdash.db,
					emdash.storage,
					previousState,
					result.data.newVersion,
					"registry",
				),
			runRollbackLifecycle: () =>
				previousState.status === "active"
					? emdash.runPluginActivateLifecycle(id)
					: Promise.resolve(),
		});

		return unwrapResult(result);
	} catch (error) {
		console.error("[registry-update] Unhandled error:", error);
		return handleError(error, "Failed to update plugin from registry", "UPDATE_FAILED");
	}
};

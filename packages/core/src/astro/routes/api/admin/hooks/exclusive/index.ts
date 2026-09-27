/**
 * Exclusive hooks list endpoint
 *
 * GET /_emdash/api/admin/hooks/exclusive
 *
 * Lists all exclusive hooks with their providers and current selections.
 * Requires admin role.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "settings:manage");
	if (denied) return denied;

	try {
		const pipeline = emdash.hooks;
		const exclusiveHookNames = pipeline.getRegisteredExclusiveHooks();

		const hooks = [];
		for (const hookName of exclusiveHookNames) {
			const providers = pipeline.getExclusiveHookProviders(hookName);
			hooks.push({
				hookName,
				providers: providers.map((provider: { pluginId: string }) => ({
					pluginId: provider.pluginId,
				})),
				selectedPluginId: pipeline.getExclusiveSelection(hookName) ?? null,
			});
		}

		return apiSuccess({ items: hooks });
	} catch (error) {
		return handleError(error, "Failed to list exclusive hooks", "EXCLUSIVE_HOOKS_LIST_ERROR");
	}
};

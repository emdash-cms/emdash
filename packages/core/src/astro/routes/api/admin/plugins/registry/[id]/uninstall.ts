/**
 * Registry plugin uninstall endpoint (experimental)
 *
 * POST /_emdash/api/admin/plugins/registry/:id/uninstall — Uninstall a
 * registry-source plugin. Mirrors the marketplace uninstall route; the
 * handler refuses non-registry sources, so this won't trash a marketplace
 * or config plugin that shares the id namespace.
 */

import type { APIRoute } from "astro";
import { z } from "zod";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import { handleRegistryUninstall } from "#api/index.js";
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

	if (!id) {
		return apiError("INVALID_REQUEST", "Plugin ID required", 400);
	}

	const body = await parseOptionalBody(request, uninstallBodySchema, {});
	if (isParseError(body)) return body;

	const result = await handleRegistryUninstall(emdash.db, emdash.storage, id, {
		deleteData: body.deleteData ?? false,
	});

	if (!result.success) return unwrapResult(result);

	await emdash.syncRegistryPlugins();

	return unwrapResult(result);
};

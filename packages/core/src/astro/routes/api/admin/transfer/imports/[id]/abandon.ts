/**
 * POST /_emdash/api/admin/transfer/imports/:id/abandon
 *
 * Abandons a failed or cancelled import so the site accepts writes again.
 * Data the import already wrote stays in place.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import { handleImportAbandon } from "#api/handlers/transfer.js";
import { requireScope } from "#auth/scopes.js";

export const prerender = false;

export const POST: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "transfer:import");
	if (denied) return denied;
	const scopeDenied = requireScope(locals, "transfer:execute");
	if (scopeDenied) return scopeDenied;

	return unwrapResult(await handleImportAbandon(emdash.db, params.id ?? "", user!.id));
};

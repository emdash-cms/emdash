import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import {
	handleMediaUsageProgress,
	handleMediaUsageProgressAdvance,
} from "#api/handlers/media-usage.js";
import { requireScope } from "#auth/scopes.js";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "schema:manage");
	if (denied) return denied;
	const scopeDenied = requireScope(locals, "admin");
	if (scopeDenied) return scopeDenied;

	return unwrapResult(await handleMediaUsageProgress(emdash.db));
};

export const POST: APIRoute = async ({ locals }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "schema:manage");
	if (denied) return denied;
	const scopeDenied = requireScope(locals, "admin");
	if (scopeDenied) return scopeDenied;

	return unwrapResult(await handleMediaUsageProgressAdvance(emdash.db));
};

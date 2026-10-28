/**
 * Dashboard stats endpoint
 *
 * GET /_emdash/api/dashboard - Collection counts, media/user counts, recent items
 */

import { hasPermission } from "@emdash-cms/auth";
import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, handleError, unwrapResult } from "#api/error.js";
import { handleDashboardStats } from "#api/handlers/dashboard.js";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
	const { emdash, user } = locals;

	const denied = requirePerm(user, "content:read");
	if (denied) return denied;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	try {
		const result = await handleDashboardStats(emdash.db, {
			includeDrafts: hasPermission(user, "content:read_drafts"),
			includeMediaCount: hasPermission(user, "media:read"),
			includeUserCount: hasPermission(user, "users:read"),
		});

		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to load dashboard", "DASHBOARD_ERROR");
	}
};

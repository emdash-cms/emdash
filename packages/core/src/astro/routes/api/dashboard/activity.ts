/**
 * Publishing activity endpoint
 *
 * GET /_emdash/api/dashboard/activity?period=day|week|month&limit=N
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, handleError, unwrapResult } from "#api/error.js";
import { handleDashboardActivity, type ActivityPeriod } from "#api/handlers/dashboard-activity.js";

export const prerender = false;

const VALID_PERIODS = new Set<string>(["day", "week", "month"]);
const DEFAULT_LIMIT: Record<ActivityPeriod, number> = { day: 30, week: 12, month: 12 };
const MAX_LIMIT = 90;

export const GET: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	const denied = requirePerm(user, "content:read");
	if (denied) return denied;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const url = new URL(request.url);
	const rawPeriod = url.searchParams.get("period") ?? "week";
	if (!VALID_PERIODS.has(rawPeriod)) {
		return apiError("VALIDATION_ERROR", "period must be day, week, or month", 400);
	}
	const period = rawPeriod as ActivityPeriod;

	const rawLimit = url.searchParams.get("limit");
	const limit = rawLimit
		? Math.min(Math.max(1, parseInt(rawLimit, 10) || 1), MAX_LIMIT)
		: DEFAULT_LIMIT[period];

	try {
		const result = await handleDashboardActivity(emdash.db, period, limit);
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to load publishing activity", "DASHBOARD_ACTIVITY_ERROR");
	}
};

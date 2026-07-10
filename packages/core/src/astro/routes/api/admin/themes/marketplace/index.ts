/**
 * Theme marketplace search proxy endpoint
 *
 * GET /_emdash/api/admin/themes/marketplace - Search marketplace themes
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import { handleThemeSearch } from "#api/index.js";

export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "plugins:read");
	if (denied) return denied;

	const query = url.searchParams.get("q") ?? undefined;
	const keyword = url.searchParams.get("keyword") ?? undefined;
	const sortParam = url.searchParams.get("sort");
	const validSorts = new Set(["name", "created", "updated"]);
	let sort: "name" | "created" | "updated" | undefined;
	if (sortParam && validSorts.has(sortParam)) {
		sort = sortParam as "name" | "created" | "updated"; // eslint-disable-line typescript/no-unsafe-type-assertion -- validated by Set.has()
	}
	const cursor = url.searchParams.get("cursor") ?? undefined;
	const limitParam = url.searchParams.get("limit");
	const limit = limitParam ? Math.min(Math.max(1, parseInt(limitParam, 10) || 50), 100) : undefined;

	const result = await handleThemeSearch(emdash.config.marketplace, query, {
		keyword,
		sort,
		cursor,
		limit,
	});

	return unwrapResult(result);
};

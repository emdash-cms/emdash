import type { APIRoute } from "astro";

import { apiError } from "#api/error.js";

import { runScheduledTasks } from "../../../middleware.js";

export const prerender = false;

/**
 * Cloudflare development bridge for EmDash-owned scheduled maintenance.
 * The integration injects this route only during Cloudflare `astro dev`.
 */
export const POST: APIRoute = async () => {
	if (!import.meta.env.DEV) {
		return apiError("FORBIDDEN", "Dev maintenance is only available in development mode", 403);
	}

	await runScheduledTasks();
	return new Response(null, { status: 204 });
};

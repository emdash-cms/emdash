import type { APIRoute } from "astro";

import { runScheduledTasks } from "../../../middleware.js";

export const prerender = false;

/**
 * Cloudflare development bridge for EmDash-owned scheduled maintenance.
 * The integration injects this route only during Cloudflare `astro dev`.
 */
export const POST: APIRoute = async () => {
	await runScheduledTasks();
	return new Response(null, { status: 204 });
};

/**
 * Read-only recommendation contract — stub until catalog + vector integration lands.
 *
 * Checkout and finalize paths stay deterministic; this route is for **suggestions only**
 * and must never mutate carts, inventory, or orders.
 */

import type { RouteContext } from "emdash";

import { requirePost } from "../lib/require-post.js";
import type { RecommendationsInput } from "../schemas.js";

export interface RecommendationsResponse {
	ok: true;
	/** Identifies response shape for clients and future MCP tools. */
	strategy: "stub";
	/** Product ids to show; empty until a recommender is wired. */
	productIds: string[];
	/** Machine-oriented note for integrators (not shown to shoppers). */
	integrationNote: string;
}

export async function recommendationsHandler(
	ctx: RouteContext<RecommendationsInput>,
): Promise<RecommendationsResponse> {
	requirePost(ctx);

	void ctx.input;

	return {
		ok: true,
		strategy: "stub",
		productIds: [],
		integrationNote:
			"Stub route: wire catalog + vector search or an external recommender; keep responses read-only.",
	};
}

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
	/** When false, storefronts should hide recommendation UI entirely. */
	enabled: false;
	strategy: "disabled";
	productIds: [];
	/** Stable machine reason; branch on this, not on free-form copy. */
	reason: "no_recommender_configured";
}

export async function recommendationsHandler(
	ctx: RouteContext<RecommendationsInput>,
): Promise<RecommendationsResponse> {
	requirePost(ctx);

	void ctx.input;

	return {
		ok: true,
		enabled: false,
		strategy: "disabled",
		productIds: [],
		reason: "no_recommender_configured",
	};
}

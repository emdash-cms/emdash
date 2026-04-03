/**
 * Read-only recommendation contract and route seam for third-party providers.
 *
 * Checkout and finalize are closed kernel paths. Recommendation hooks are
 * explicitly read-only and may only post-derive product IDs.
 */

import type { RouteContext } from "emdash";

import { requirePost } from "../lib/require-post.js";
import type { RecommendationsInput } from "../schemas.js";
import type { CommerceRecommendationResolver } from "../catalog-extensibility.js";
import type { CommerceRecommendationResult, CommerceRecommendationInput } from "../catalog-extensibility.js";

export interface RecommendationsResponseBase {
	ok: true;
	productIds: readonly string[];
	reason: string;
}

export interface RecommendationsDisabledResponse extends RecommendationsResponseBase {
	enabled: false;
	strategy: "disabled";
	productIds: [];
	reason: "no_recommender_configured" | "provider_error" | "provider_empty" | "provider_invalid";
}

export interface RecommendationsEnabledResponse extends RecommendationsResponseBase {
	enabled: true;
	strategy: "provider";
	providerId?: string;
}

export type RecommendationsResponse = RecommendationsDisabledResponse | RecommendationsEnabledResponse;

export type RecommendationsHandlerOptions = {
	resolver?: CommerceRecommendationResolver;
	providerId?: string;
};

const DISABLED_PROVIDER_RESPONSE: RecommendationsDisabledResponse = {
	ok: true,
	enabled: false,
	strategy: "disabled",
	productIds: [],
	reason: "no_recommender_configured",
};

function normalizeLimit(limit: number | undefined): number {
	if (typeof limit !== "number" || !Number.isFinite(limit)) return 10;
	if (limit < 1) return 1;
	return limit;
}

function toInput(input: RecommendationsInput): CommerceRecommendationInput {
	return {
		productId: input.productId,
		variantId: input.variantId,
		cartId: input.cartId,
		limit: normalizeLimit(input.limit),
	};
}

function buildProviderResponse(
	result: CommerceRecommendationResult | null | undefined,
	inputLimit: number,
	fallbackProviderId?: string,
): RecommendationsResponse {
	if (!result) {
		return {
			...DISABLED_PROVIDER_RESPONSE,
			reason: "no_recommender_configured",
		};
	}
	const productIds = (result.productIds ?? [])
		.filter((value): value is string => typeof value === "string" && value.length > 0)
		.filter((value, index, list) => index === list.indexOf(value))
		.slice(0, inputLimit);
	if (productIds.length === 0) {
		return {
			...DISABLED_PROVIDER_RESPONSE,
			reason: "provider_empty",
		};
	}
	return {
		ok: true,
		enabled: true,
		strategy: "provider",
		productIds,
		providerId: result.providerId ?? fallbackProviderId,
		reason: result.reason ?? "provider_result",
	};
}

export function createRecommendationsHandler(
	options: RecommendationsHandlerOptions = {},
): (ctx: RouteContext<RecommendationsInput>) => Promise<RecommendationsResponse> {
	return async function recommendationsHandler(ctx: RouteContext<RecommendationsInput>): Promise<RecommendationsResponse> {
		requirePost(ctx);
		const input = toInput(ctx.input);
		if (!options.resolver) {
			return DISABLED_PROVIDER_RESPONSE;
		}

		try {
			const resolved = await options.resolver(input);
			return buildProviderResponse(resolved, input.limit ?? 10, options.providerId);
		} catch {
			return {
				ok: true,
				enabled: false,
				strategy: "disabled",
				productIds: [],
				reason: "provider_error",
			};
		}
	};
}

export async function recommendationsHandler(
	ctx: RouteContext<RecommendationsInput>,
): Promise<RecommendationsResponse> {
	return createRecommendationsHandler()(ctx);
}

/**
 * Type-level contract to make the read-only recommendation seam obvious to
 * external plugins and MCP tooling.
 */
export type { CommerceRecommendationResult, CommerceRecommendationInput };

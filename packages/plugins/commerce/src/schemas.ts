/**
 * Zod input validation for commerce plugin routes.
 */

import { z } from "astro/zod";

import { COMMERCE_LIMITS } from "./kernel/limits.js";

const bounded = (max: number) => z.string().min(1).max(max);

export const checkoutInputSchema = z.object({
	cartId: bounded(COMMERCE_LIMITS.maxWebhookFieldLength),
	/** Optional when `Idempotency-Key` header is set. */
	idempotencyKey: z.string().optional(),
});

export type CheckoutInput = z.infer<typeof checkoutInputSchema>;

/** Same possession proof as webhook finalize when the order stores `finalizeTokenHash`. */
export const checkoutGetOrderInputSchema = z.object({
	orderId: bounded(COMMERCE_LIMITS.maxWebhookFieldLength),
	finalizeToken: z.string().min(16).max(256).optional(),
});

export type CheckoutGetOrderInput = z.infer<typeof checkoutGetOrderInputSchema>;

export const stripeWebhookInputSchema = z.object({
	orderId: bounded(COMMERCE_LIMITS.maxWebhookFieldLength),
	externalEventId: bounded(COMMERCE_LIMITS.maxWebhookFieldLength),
	providerId: z.string().min(1).max(64).default("stripe"),
	correlationId: z.string().min(1).max(COMMERCE_LIMITS.maxWebhookFieldLength).optional(),
	/**
	 * Must match the secret returned from `checkout` (also embedded in gateway metadata).
	 * Required whenever the order document carries `finalizeTokenHash`.
	 */
	finalizeToken: z.string().min(16).max(256).optional(),
});

export type StripeWebhookInput = z.infer<typeof stripeWebhookInputSchema>;

export const recommendationsInputSchema = z.object({
	/** Hint for “similar to this product” (catalog id). */
	productId: bounded(COMMERCE_LIMITS.maxWebhookFieldLength).optional(),
	variantId: bounded(COMMERCE_LIMITS.maxWebhookFieldLength).optional(),
	cartId: bounded(COMMERCE_LIMITS.maxWebhookFieldLength).optional(),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(COMMERCE_LIMITS.maxRecommendationsLimit)
		.optional(),
});

export type RecommendationsInput = z.infer<typeof recommendationsInputSchema>;

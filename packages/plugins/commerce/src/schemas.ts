/**
 * Zod input validation for commerce plugin routes.
 */

import { z } from "astro/zod";

import { COMMERCE_LIMITS } from "./kernel/limits.js";

const bounded = (max: number) => z.string().min(1).max(max);

/**
 * Shared cart line item fragment — same invariants enforced at cart boundary
 * and re-checked at checkout (defence in depth, not duplication).
 */
export const cartLineItemSchema = z.object({
	productId: bounded(COMMERCE_LIMITS.maxWebhookFieldLength),
	variantId: z.string().min(0).max(COMMERCE_LIMITS.maxWebhookFieldLength).optional(),
	quantity: z
		.number()
		.int()
		.min(1, "Quantity must be at least 1")
		.max(COMMERCE_LIMITS.maxLineItemQty, `Quantity must not exceed ${COMMERCE_LIMITS.maxLineItemQty}`),
	/**
	 * Snapshot of the inventory version at the time the item was added to the cart.
	 * Used for optimistic concurrency during finalize.
	 */
	inventoryVersion: z
		.number()
		.int()
		.min(0, "Inventory version must be a non-negative integer"),
	/** Price in the smallest currency unit (e.g. cents). Must be non-negative. */
	unitPriceMinor: z
		.number()
		.int()
		.min(0, "Unit price must be a non-negative integer"),
});

export type CartLineItemInput = z.infer<typeof cartLineItemSchema>;

export const cartUpsertInputSchema = z.object({
	cartId: bounded(COMMERCE_LIMITS.maxWebhookFieldLength),
	currency: z.string().min(3).max(3).toUpperCase(),
	lineItems: z
		.array(cartLineItemSchema)
		.min(0)
		.max(
			COMMERCE_LIMITS.maxCartLineItems,
			`Cart must not exceed ${COMMERCE_LIMITS.maxCartLineItems} line items`,
		),
	/**
	 * Required when mutating an existing cart (i.e. the cart already has an ownerTokenHash).
	 * Absent on first creation — the server issues a fresh token and returns it once.
	 */
	ownerToken: z.string().min(16).max(256).optional(),
});

export type CartUpsertInput = z.infer<typeof cartUpsertInputSchema>;

export const cartGetInputSchema = z.object({
	cartId: bounded(COMMERCE_LIMITS.maxWebhookFieldLength),
	/**
	 * Required when the cart has `ownerTokenHash` (same secret returned once from `cart/upsert`).
	 * Omitted for legacy carts that have not been migrated yet.
	 */
	ownerToken: z.string().min(16).max(256).optional(),
});

export type CartGetInput = z.infer<typeof cartGetInputSchema>;

export const checkoutInputSchema = z.object({
	cartId: bounded(COMMERCE_LIMITS.maxWebhookFieldLength),
	/** Optional when `Idempotency-Key` header is set. */
	idempotencyKey: z.string().optional(),
});

export type CheckoutInput = z.infer<typeof checkoutInputSchema>;

/**
 * Possession proof for order read: must match checkout's `finalizeToken` for this `orderId`.
 * Optional in schema; handler rejects missing/invalid token (and legacy orders without a hash).
 */
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

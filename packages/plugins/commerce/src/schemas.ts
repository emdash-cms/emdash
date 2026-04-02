/**
 * Zod input validation for commerce plugin routes.
 */

import { z } from "astro/zod";

export const checkoutInputSchema = z.object({
	cartId: z.string().min(1),
	/** Optional when `Idempotency-Key` header is set. */
	idempotencyKey: z.string().optional(),
});

export type CheckoutInput = z.infer<typeof checkoutInputSchema>;

export const stripeWebhookInputSchema = z.object({
	orderId: z.string().min(1),
	externalEventId: z.string().min(1),
	providerId: z.string().min(1).default("stripe"),
	correlationId: z.string().min(1).optional(),
});

export type StripeWebhookInput = z.infer<typeof stripeWebhookInputSchema>;

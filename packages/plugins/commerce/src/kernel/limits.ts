/** Hard caps — enforce in route handlers before kernel work. */
export const COMMERCE_LIMITS = {
	maxCartLineItems: 50,
	maxLineItemQty: 999,
	maxIdempotencyKeyLength: 128,
	minIdempotencyKeyLength: 16,
	/** Server-side idempotency replay window (matches architecture TTL guidance). */
	idempotencyRecordTtlMs: 86_400_000,
	/** Default fixed window for public cart/checkout rate limits (ms) */
	defaultRateWindowMs: 60_000,
	defaultCheckoutPerIpPerWindow: 30,
	defaultCartMutationsPerTokenPerWindow: 120,
	defaultWebhookPerIpPerWindow: 120,
	/** Bound attacker-controlled strings on webhook JSON (before Stripe raw body lands). */
	maxWebhookFieldLength: 512,
	/** Cap on `recommendations` route `limit` query/body field. */
	maxRecommendationsLimit: 20,
} as const;

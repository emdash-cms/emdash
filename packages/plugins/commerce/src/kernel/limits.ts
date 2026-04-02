/** Hard caps — enforce in route handlers before kernel work. */
export const COMMERCE_LIMITS = {
	maxCartLineItems: 50,
	maxLineItemQty: 999,
	maxIdempotencyKeyLength: 128,
	minIdempotencyKeyLength: 16,
	/** Default sliding window for public cart/checkout rate limits (ms) */
	defaultRateWindowMs: 60_000,
	defaultCheckoutPerIpPerWindow: 30,
	defaultCartMutationsPerTokenPerWindow: 120,
} as const;

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
	/**
	 * Finalization diagnostics (`queryFinalizationState`) per client IP per window.
	 * Tuned for moderate dashboard/MCP polling without hammering plugin storage.
	 */
	defaultFinalizationDiagnosticsPerIpPerWindow: 60,
	/** Short KV read-through TTL for finalization diagnostics (Option B). */
	finalizationDiagnosticsCacheTtlMs: 10_000,
	/** Bound attacker-controlled strings on webhook JSON (before Stripe raw body lands). */
	maxWebhookFieldLength: 512,
	/** Cap on `recommendations` route `limit` query/body field. */
	maxRecommendationsLimit: 20,
	/** Max raw webhook payload bytes validated before signature verification. */
	maxWebhookBodyBytes: 65_536,
} as const;

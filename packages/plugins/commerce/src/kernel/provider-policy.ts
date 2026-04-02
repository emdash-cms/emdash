/**
 * Defaults for outbound payment-provider HTTP calls (Layer B applies these).
 * Adapters may override per gateway.
 */
export const PROVIDER_HTTP_POLICY = {
	initiateTimeoutMs: 15_000,
	refundTimeoutMs: 30_000,
	/** Max retries for safe GET-style provider status polls only */
	maxIdempotentRetries: 2,
	retryBackoffMs: [200, 800] as const,
	circuitFailureThreshold: 5,
	circuitWindowMs: 60_000,
	circuitCooldownMs: 30_000,
} as const;

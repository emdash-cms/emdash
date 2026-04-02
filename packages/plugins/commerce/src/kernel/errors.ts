/**
 * Stable error metadata for commerce routes (subset; see commerce-plugin-architecture §16).
 * Kernel stays free of HTTP — callers map codes to responses.
 */
export const COMMERCE_ERROR_META = {
	WEBHOOK_REPLAY_DETECTED: { httpStatus: 200 as const, retryable: false as const },
	PAYMENT_ALREADY_PROCESSED: { httpStatus: 409 as const, retryable: false as const },
	ORDER_STATE_CONFLICT: { httpStatus: 409 as const, retryable: false as const },
	INSUFFICIENT_STOCK: { httpStatus: 409 as const, retryable: false as const },
	PAYMENT_CONFLICT: { httpStatus: 409 as const, retryable: false as const },
	RATE_LIMITED: { httpStatus: 429 as const, retryable: true as const },
	PAYLOAD_TOO_LARGE: { httpStatus: 413 as const, retryable: false as const },
} as const;

export type CommerceErrorCode = keyof typeof COMMERCE_ERROR_META;

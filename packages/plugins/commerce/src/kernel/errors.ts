/**
 * Canonical error metadata for commerce routes (kernel layer exports this contract data only).
 * Route handlers map these entries to client/API responses.
 */
export const COMMERCE_ERRORS = {
	// Inventory
	INVENTORY_CHANGED: { httpStatus: 409, retryable: false },
	INSUFFICIENT_STOCK: { httpStatus: 409, retryable: false },

	// Product / catalog
	PRODUCT_UNAVAILABLE: { httpStatus: 404, retryable: false },
	VARIANT_UNAVAILABLE: { httpStatus: 404, retryable: false },

	// Cart
	CART_NOT_FOUND: { httpStatus: 404, retryable: false },
	CART_EXPIRED: { httpStatus: 410, retryable: false },
	CART_EMPTY: { httpStatus: 422, retryable: false },

	// Order
	ORDER_NOT_FOUND: { httpStatus: 404, retryable: false },
	ORDER_STATE_CONFLICT: { httpStatus: 409, retryable: false },
	PAYMENT_CONFLICT: { httpStatus: 409, retryable: false },

	// Payment
	PAYMENT_INITIATION_FAILED: { httpStatus: 502, retryable: true },
	PAYMENT_CONFIRMATION_FAILED: { httpStatus: 502, retryable: false },
	PAYMENT_ALREADY_PROCESSED: { httpStatus: 409, retryable: false },
	PROVIDER_UNAVAILABLE: { httpStatus: 503, retryable: true },

	// Webhooks
	WEBHOOK_SIGNATURE_INVALID: { httpStatus: 401, retryable: false },
	WEBHOOK_REPLAY_DETECTED: { httpStatus: 200, retryable: false },

	// Discounts / coupons
	INVALID_DISCOUNT: { httpStatus: 422, retryable: false },
	DISCOUNT_EXPIRED: { httpStatus: 410, retryable: false },

	// Features / config
	FEATURE_NOT_ENABLED: { httpStatus: 501, retryable: false },
	CURRENCY_MISMATCH: { httpStatus: 422, retryable: false },
	SHIPPING_REQUIRED: { httpStatus: 422, retryable: false },

	// Abuse / limits
	RATE_LIMITED: { httpStatus: 429, retryable: true },
	PAYLOAD_TOO_LARGE: { httpStatus: 413, retryable: false },
} as const satisfies Record<string, { httpStatus: number; retryable: boolean }>;

export type CommerceErrorCode = keyof typeof COMMERCE_ERRORS;

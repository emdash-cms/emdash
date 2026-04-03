/**
 * Canonical error metadata for commerce (kernel).
 *
 * **Internal vs wire:** `COMMERCE_ERRORS` keys are **internal** identifiers
 * (`UPPER_SNAKE`, stable for TypeScript and kernel branches). Public HTTP/API
 * payloads must use **wire** codes: `snake_case` strings from
 * `COMMERCE_ERROR_WIRE_CODES` / `commerceErrorCodeToWire()`. Route handlers are
 * responsible for that mapping; the kernel does not emit HTTP.
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
	/** Caller did not supply an owner token but the cart requires one. */
	CART_TOKEN_REQUIRED: { httpStatus: 401, retryable: false },
	/** Supplied owner token does not match the stored hash. */
	CART_TOKEN_INVALID: { httpStatus: 403, retryable: false },

	// Order
	ORDER_NOT_FOUND: { httpStatus: 404, retryable: false },
	ORDER_STATE_CONFLICT: { httpStatus: 409, retryable: false },
	PAYMENT_CONFLICT: { httpStatus: 409, retryable: false },
	/** Caller did not supply a finalizeToken but the order requires one. */
	ORDER_TOKEN_REQUIRED: { httpStatus: 401, retryable: false },
	/** Supplied finalizeToken does not match the stored hash. */
	ORDER_TOKEN_INVALID: { httpStatus: 403, retryable: false },

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

/** Wire-level / public API error code (snake_case), stable across versions. */
export const COMMERCE_ERROR_WIRE_CODES = {
	INVENTORY_CHANGED: "inventory_changed",
	INSUFFICIENT_STOCK: "insufficient_stock",
	PRODUCT_UNAVAILABLE: "product_unavailable",
	VARIANT_UNAVAILABLE: "variant_unavailable",
	CART_NOT_FOUND: "cart_not_found",
	CART_EXPIRED: "cart_expired",
	CART_EMPTY: "cart_empty",
	CART_TOKEN_REQUIRED: "cart_token_required",
	CART_TOKEN_INVALID: "cart_token_invalid",
	ORDER_NOT_FOUND: "order_not_found",
	ORDER_STATE_CONFLICT: "order_state_conflict",
	PAYMENT_CONFLICT: "payment_conflict",
	ORDER_TOKEN_REQUIRED: "order_token_required",
	ORDER_TOKEN_INVALID: "order_token_invalid",
	PAYMENT_INITIATION_FAILED: "payment_initiation_failed",
	PAYMENT_CONFIRMATION_FAILED: "payment_confirmation_failed",
	PAYMENT_ALREADY_PROCESSED: "payment_already_processed",
	PROVIDER_UNAVAILABLE: "provider_unavailable",
	WEBHOOK_SIGNATURE_INVALID: "webhook_signature_invalid",
	WEBHOOK_REPLAY_DETECTED: "webhook_replay_detected",
	INVALID_DISCOUNT: "invalid_discount",
	DISCOUNT_EXPIRED: "discount_expired",
	FEATURE_NOT_ENABLED: "feature_not_enabled",
	CURRENCY_MISMATCH: "currency_mismatch",
	SHIPPING_REQUIRED: "shipping_required",
	RATE_LIMITED: "rate_limited",
	PAYLOAD_TOO_LARGE: "payload_too_large",
} as const satisfies Record<CommerceErrorCode, string>;

export type CommerceWireErrorCode = (typeof COMMERCE_ERROR_WIRE_CODES)[CommerceErrorCode];

export function commerceErrorCodeToWire(code: CommerceErrorCode): CommerceWireErrorCode {
	return COMMERCE_ERROR_WIRE_CODES[code];
}

import { describe, expect, it } from "vitest";
import { COMMERCE_ERRORS } from "./errors.js";
import { toCommerceApiError } from "./api-errors.js";

describe("toCommerceApiError", () => {
	it("maps internal error code to wire code and metadata", () => {
		const error = toCommerceApiError({
			code: "PAYMENT_ALREADY_PROCESSED",
			message: "Payment already captured",
		});

		expect(error.code).toBe("payment_already_processed");
		expect(error.httpStatus).toBe(COMMERCE_ERRORS.PAYMENT_ALREADY_PROCESSED.httpStatus);
		expect(error.retryable).toBe(
			COMMERCE_ERRORS.PAYMENT_ALREADY_PROCESSED.retryable,
		);
		expect(error.message).toBe("Payment already captured");
		expect(error.details).toBeUndefined();
	});

	it("preserves optional details", () => {
		const error = toCommerceApiError({
			code: "ORDER_STATE_CONFLICT",
			message: "Order is not in finalizable state",
			details: { orderId: "ord_123", phase: "canceled" },
		});

		expect(error.details).toEqual({ orderId: "ord_123", phase: "canceled" });
		expect(error.code).toBe("order_state_conflict");
	});

	it("preserves retryable metadata for retryable errors", () => {
		const error = toCommerceApiError({
			code: "PROVIDER_UNAVAILABLE",
			message: "Provider timed out",
		});

		expect(error.code).toBe("provider_unavailable");
		expect(error.retryable).toBe(true);
		expect(error.httpStatus).toBe(COMMERCE_ERRORS.PROVIDER_UNAVAILABLE.httpStatus);
	});

	it("preserves retryable metadata for non-retryable errors", () => {
		const error = toCommerceApiError({
			code: "WEBHOOK_SIGNATURE_INVALID",
			message: "Invalid webhook signature",
		});

		expect(error.code).toBe("webhook_signature_invalid");
		expect(error.retryable).toBe(false);
		expect(error.httpStatus).toBe(
			COMMERCE_ERRORS.WEBHOOK_SIGNATURE_INVALID.httpStatus,
		);
	});
});


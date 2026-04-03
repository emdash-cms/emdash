import { describe, expect, it } from "vitest";

import {
	PAYMENT_DEFAULTS,
	COMMERCE_MCP_ACTORS,
	resolvePaymentProviderId,
} from "./commerce-provider-contracts.js";

describe("commerce-provider-contracts", () => {
	it("resolves an empty or missing payment provider id to the default", () => {
		expect(resolvePaymentProviderId(undefined)).toBe(PAYMENT_DEFAULTS.defaultPaymentProviderId);
		expect(resolvePaymentProviderId("")).toBe(PAYMENT_DEFAULTS.defaultPaymentProviderId);
		expect(resolvePaymentProviderId("   ")).toBe(PAYMENT_DEFAULTS.defaultPaymentProviderId);
	});

	it("preserves explicit provider ids", () => {
		expect(resolvePaymentProviderId("stripe")).toBe("stripe");
		expect(resolvePaymentProviderId("paypal")).toBe("paypal");
	});

	it("exports deterministic MCP actor contract", () => {
		expect(Object.keys(COMMERCE_MCP_ACTORS)).toEqual([
			"system",
			"merchant",
			"agent",
			"customer",
		]);
		expect(COMMERCE_MCP_ACTORS.system).toBe("system");
		expect(COMMERCE_MCP_ACTORS.customer).toBe("customer");
	});
});

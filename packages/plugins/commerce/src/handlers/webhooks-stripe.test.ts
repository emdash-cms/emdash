import { describe, expect, it, vi } from "vitest";

import {
	hashWithSecret,
	isWebhookSignatureValid,
	parseStripeSignatureHeader,
} from "./webhooks-stripe.js";

describe("stripe webhook signature helpers", () => {
	const secret = "whsec_test_secret";
	const rawBody = JSON.stringify({ orderId: "o1", externalEventId: "evt_1" });
	const timestamp = 1_760_000_000;

	it("parses stripe signature header", () => {
		const sig = `t=${timestamp},v1=${hashWithSecret(secret, timestamp, rawBody)},v1=ignored`;
		const parsed = parseStripeSignatureHeader(sig);
		expect(parsed).toEqual({
			timestamp,
			signatures: [hashWithSecret(secret, timestamp, rawBody), "ignored"],
		});
	});

	it("validates a matching v1 signature", () => {
		const sig = `t=${timestamp},v1=${hashWithSecret(secret, timestamp, rawBody)}`;
		expect(isWebhookSignatureValid(secret, rawBody, sig)).toBe(true);
	});

	it("rejects mismatched secret", () => {
		const sig = `t=${timestamp},v1=${hashWithSecret(secret, timestamp, rawBody)}`;
		expect(isWebhookSignatureValid("whsec_other_secret", rawBody, sig)).toBe(false);
	});

	it("rejects missing timestamp", () => {
		const sig = `v1=${hashWithSecret(secret, timestamp, rawBody)}`;
		expect(isWebhookSignatureValid(secret, rawBody, sig)).toBe(false);
	});

	it("rejects stale signatures", () => {
		const oldTimestamp = timestamp - 360;
		const sig = `t=${oldTimestamp},v1=${hashWithSecret(secret, oldTimestamp, rawBody)}`;
		const mockNow = oldTimestamp + 10; // very stale in seconds
		const restore = vi.spyOn(Date, "now").mockReturnValue(mockNow * 1000);
		expect(isWebhookSignatureValid(secret, rawBody, sig)).toBe(false);
		restore.mockRestore();
	});
});


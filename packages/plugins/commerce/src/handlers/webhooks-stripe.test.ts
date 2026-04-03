import { describe, expect, it, vi } from "vitest";

import {
	hashWithSecret,
	isWebhookBodyWithinSizeLimit,
	isWebhookSignatureValid,
	parseStripeSignatureHeader,
} from "./webhooks-stripe.js";

describe("stripe webhook signature helpers", () => {
	const secret = "whsec_test_secret";
	const rawBody = JSON.stringify({ orderId: "o1", externalEventId: "evt_1" });
	const timestamp = 1_760_000_000;

	it("parses stripe signature header", async () => {
		const hash = await hashWithSecret(secret, timestamp, rawBody);
		const sig = `t=${timestamp},v1=${hash},v1=ignored`;
		const parsed = parseStripeSignatureHeader(sig);
		expect(parsed).toEqual({
			timestamp,
			signatures: [hash, "ignored"],
		});
	});

	it("validates a matching v1 signature", async () => {
		const hash = await hashWithSecret(secret, timestamp, rawBody);
		const sig = `t=${timestamp},v1=${hash}`;
		const restore = vi.spyOn(Date, "now").mockReturnValue(timestamp * 1000);
		expect(await isWebhookSignatureValid(secret, rawBody, sig)).toBe(true);
		restore.mockRestore();
	});

	it("rejects mismatched secret", async () => {
		const hash = await hashWithSecret(secret, timestamp, rawBody);
		const sig = `t=${timestamp},v1=${hash}`;
		expect(await isWebhookSignatureValid("whsec_other_secret", rawBody, sig)).toBe(false);
	});

	it("rejects missing timestamp", async () => {
		const hash = await hashWithSecret(secret, timestamp, rawBody);
		const sig = `v1=${hash}`;
		expect(await isWebhookSignatureValid(secret, rawBody, sig)).toBe(false);
	});

	it("rejects stale signatures", async () => {
		const oldTimestamp = timestamp - 360;
		const hash = await hashWithSecret(secret, oldTimestamp, rawBody);
		const sig = `t=${oldTimestamp},v1=${hash}`;
		// Tolerance is 300s; advance wall clock well beyond that vs signature timestamp.
		const mockNowSeconds = oldTimestamp + 400;
		const restore = vi.spyOn(Date, "now").mockReturnValue(mockNowSeconds * 1000);
		expect(await isWebhookSignatureValid(secret, rawBody, sig)).toBe(false);
		restore.mockRestore();
	});

	it("accepts raw webhook bodies inside byte-size limit", () => {
		expect(isWebhookBodyWithinSizeLimit("a".repeat(65_536))).toBe(true);
	});

	it("rejects raw webhook bodies over byte-size limit", () => {
		expect(isWebhookBodyWithinSizeLimit("a".repeat(65_537))).toBe(false);
	});
});

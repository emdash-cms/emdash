import { beforeEach, describe, expect, it, vi } from "vitest";

const finalizePaymentFromWebhook = vi.fn();

vi.mock("../orchestration/finalize-payment.js", () => ({
	__esModule: true,
	finalizePaymentFromWebhook: (...args: unknown[]) => finalizePaymentFromWebhook(...args),
}));
vi.mock("../lib/rate-limit-kv.js", () => ({
	__esModule: true,
	consumeKvRateLimit: async () => true,
}));

import { createPaymentWebhookRoute } from "../services/commerce-extension-seams.js";
import type { handlePaymentWebhook } from "./webhook-handler.js";

describe("payment webhook seam", () => {
	beforeEach(() => {
		finalizePaymentFromWebhook.mockReset();
	});

	function ctx(): Parameters<typeof handlePaymentWebhook>[0] {
		return {
			request: new Request("https://example.test/webhooks/stripe", {
				method: "POST",
				body: JSON.stringify({ orderId: "order_1", externalEventId: "evt_1", finalizeToken: "tok" }),
				headers: { "content-length": "57" },
			}),
			input: { orderId: "order_1", externalEventId: "evt_1", finalizeToken: "tok" },
			storage: {
				orders: {} as never,
				webhookReceipts: {} as never,
				paymentAttempts: {} as never,
				inventoryLedger: {} as never,
				inventoryStock: {} as never,
			},
			kv: {} as never,
			requestMeta: { ip: "127.0.0.1" },
			log: {
				info: () => undefined,
				warn: () => undefined,
				error: () => undefined,
				debug: () => undefined,
			},
		} as never;
	}

	const adapter = {
		providerId: "stripe",
		verifyRequest: vi.fn(async () => undefined),
		buildFinalizeInput: vi.fn(() => ({
			orderId: "order_1",
			externalEventId: "evt_1",
			finalizeToken: "tok",
		})),
		buildCorrelationId: vi.fn(() => "corr:evt_1"),
		buildRateLimitSuffix: vi.fn(() => "stripe:ip"),
	};

	it("adapts provider input and delegates to finalize-payment", async () => {
		finalizePaymentFromWebhook.mockResolvedValue({
			kind: "completed",
			orderId: "order_1",
		});

		const out = await createPaymentWebhookRoute(adapter)(ctx());

		expect(adapter.verifyRequest).toHaveBeenCalledTimes(1);
		expect(adapter.buildFinalizeInput).toHaveBeenCalledTimes(1);
		expect(finalizePaymentFromWebhook).toHaveBeenCalledTimes(1);
		expect(finalizePaymentFromWebhook).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				orderId: "order_1",
				externalEventId: "evt_1",
				finalizeToken: "tok",
				providerId: "stripe",
				correlationId: "corr:evt_1",
			}),
		);
		expect(out).toEqual({ ok: true, replay: false, orderId: "order_1" });
	});
});

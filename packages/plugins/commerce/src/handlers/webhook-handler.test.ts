import { beforeEach, describe, expect, it, vi } from "vitest";

const finalizePaymentFromWebhook = vi.fn();
const consumeKvRateLimit = vi.fn(async (_opts?: unknown) => true);

vi.mock("../orchestration/finalize-payment.js", () => ({
	__esModule: true,
	finalizePaymentFromWebhook: (...args: unknown[]) => finalizePaymentFromWebhook(...args),
}));
vi.mock("../lib/rate-limit-kv.js", () => ({
	__esModule: true,
	consumeKvRateLimit: (opts: unknown) => consumeKvRateLimit(opts),
}));

import { createPaymentWebhookRoute } from "../services/commerce-extension-seams.js";
import type { handlePaymentWebhook } from "./webhook-handler.js";

describe("payment webhook seam", () => {
	beforeEach(() => {
		finalizePaymentFromWebhook.mockReset();
		consumeKvRateLimit.mockReset();
		consumeKvRateLimit.mockResolvedValue(true);
	});

	function ctx(): Parameters<typeof handlePaymentWebhook>[0] {
		return {
			request: new Request("https://example.test/webhooks/stripe", {
				method: "POST",
				body: JSON.stringify({
					orderId: "order_1",
					externalEventId: "evt_1",
					finalizeToken: "tok",
				}),
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

	it("rejects non-POST webhook requests", async () => {
		await expect(
			createPaymentWebhookRoute(adapter)({
				...(ctx() as ReturnType<typeof ctx>),
				request: new Request("https://example.test/webhooks/stripe", { method: "GET" }),
			} as never),
		).rejects.toMatchObject({ code: "METHOD_NOT_ALLOWED" });
	});

	it("rejects oversized webhook payload by header cap", async () => {
		await expect(
			createPaymentWebhookRoute(adapter)({
				...(ctx() as ReturnType<typeof ctx>),
				request: new Request("https://example.test/webhooks/stripe", {
					method: "POST",
					body: "{}",
					headers: { "content-length": `${Number.MAX_SAFE_INTEGER}` },
				}),
			} as never),
		).rejects.toMatchObject({ code: "payload_too_large" });
	});

	it("rejects oversized webhook payload when content-length is missing or malformed", async () => {
		const bigBody = "x".repeat(65_537);
		await expect(
			createPaymentWebhookRoute(adapter)({
				...(ctx() as ReturnType<typeof ctx>),
				request: new Request("https://example.test/webhooks/stripe", {
					method: "POST",
					body: bigBody,
					headers: { "content-length": "not-a-number" },
				}),
			} as never),
		).rejects.toMatchObject({ code: "payload_too_large" });
	});

	it("enforces webhook rate limit", async () => {
		consumeKvRateLimit.mockResolvedValueOnce(false);
		await expect(createPaymentWebhookRoute(adapter)(ctx())).rejects.toMatchObject({
			code: "rate_limited",
		});
		expect(consumeKvRateLimit).toHaveBeenCalledTimes(1);
	});

	it("dedupes concurrent duplicate webhook deliveries", async () => {
		let resolveFinalize!: () => void;
		const finalizePromise = new Promise<{ kind: "completed"; orderId: string }>((resolve) => {
			resolveFinalize = () => resolve({ kind: "completed", orderId: "order_1" });
		});
		finalizePaymentFromWebhook.mockReturnValue(finalizePromise);

		const first = createPaymentWebhookRoute(adapter)(ctx());
		const second = createPaymentWebhookRoute(adapter)(ctx());
		const all = Promise.all([first, second]);

		resolveFinalize();
		const [firstResult, secondResult] = await all;
		expect(finalizePaymentFromWebhook).toHaveBeenCalledTimes(1);
		expect(firstResult).toEqual({ ok: true, replay: false, orderId: "order_1" });
		expect(secondResult).toEqual({ ok: true, replay: false, orderId: "order_1" });
	});
});

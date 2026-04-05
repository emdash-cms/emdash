import { beforeEach, describe, expect, it, vi } from "vitest";

import { STRIPE_WEBHOOK_SIGNATURE } from "../services/commerce-provider-contracts.js";
import {
	clampStripeTolerance,
	extractStripeFinalizeMetadata,
	hashWithSecret,
	isWebhookBodyWithinSizeLimit,
	isWebhookSignatureValid,
	parseStripeSignatureHeader,
	resolveWebhookSignatureToleranceSeconds,
	stripeWebhookHandler,
} from "./webhooks-stripe.js";

const finalizePaymentFromWebhook = vi.fn<(ports: unknown, input: unknown) => Promise<unknown>>();
const consumeKvRateLimit = vi.fn<
	(input: {
		kv: unknown;
		keySuffix: string;
		limit: number;
		windowMs: number;
		nowMs: number;
	}) => Promise<boolean>
>(async () => true);

vi.mock("../orchestration/finalize-payment.js", () => ({
	__esModule: true,
	finalizePaymentFromWebhook: (...args: Parameters<typeof finalizePaymentFromWebhook>) =>
		finalizePaymentFromWebhook(...args),
}));
vi.mock("../lib/rate-limit-kv.js", () => ({
	__esModule: true,
	consumeKvRateLimit: (...args: Parameters<typeof consumeKvRateLimit>) => consumeKvRateLimit(...args),
}));

describe("stripe webhook signature helpers", () => {
	const secret = "whsec_test_secret";
	const rawBody = JSON.stringify({ orderId: "o1", externalEventId: "evt_1" });
	const rawStripeEventBody = JSON.stringify({
		id: "evt_live_test",
		type: "payment_intent.succeeded",
		data: {
			object: {
				id: "pi_live_test",
				metadata: {
					emdashOrderId: "order_1",
					emdashFinalizeToken: "token_12345678901234",
				},
			},
		},
	});
	const timestamp = 1_760_000_000;

	beforeEach(() => {
		finalizePaymentFromWebhook.mockReset();
		consumeKvRateLimit.mockReset();
		consumeKvRateLimit.mockResolvedValue(true);
	});

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
		expect(await isWebhookSignatureValid(secret, rawBody, sig, 300)).toBe(true);
		restore.mockRestore();
	});

	it("rejects mismatched secret", async () => {
		const hash = await hashWithSecret(secret, timestamp, rawBody);
		const sig = `t=${timestamp},v1=${hash}`;
		expect(await isWebhookSignatureValid("whsec_other_secret", rawBody, sig, 300)).toBe(false);
	});

	it("rejects missing timestamp", async () => {
		const hash = await hashWithSecret(secret, timestamp, rawBody);
		const sig = `v1=${hash}`;
		expect(await isWebhookSignatureValid(secret, rawBody, sig, 300)).toBe(false);
	});

	it("rejects stale signatures", async () => {
		const oldTimestamp = timestamp - 360;
		const hash = await hashWithSecret(secret, oldTimestamp, rawBody);
		const sig = `t=${oldTimestamp},v1=${hash}`;
		// Tolerance is 300s; advance wall clock well beyond that vs signature timestamp.
		const mockNowSeconds = oldTimestamp + 400;
		const restore = vi.spyOn(Date, "now").mockReturnValue(mockNowSeconds * 1000);
		expect(await isWebhookSignatureValid(secret, rawBody, sig, 300)).toBe(false);
		restore.mockRestore();
	});

	it("accepts raw webhook bodies inside byte-size limit", () => {
		expect(isWebhookBodyWithinSizeLimit("a".repeat(65_536))).toBe(true);
	});

	it("rejects raw webhook bodies over byte-size limit", () => {
		expect(isWebhookBodyWithinSizeLimit("a".repeat(65_537))).toBe(false);
	});

	it("extracts Stripe finalize metadata from verified event payload", () => {
		const metadata = extractStripeFinalizeMetadata(JSON.parse(rawStripeEventBody));
		expect(metadata).toEqual({
			externalEventId: "evt_live_test",
			orderId: "order_1",
			finalizeToken: "token_12345678901234",
		});
	});

	it("rejects event payload without required metadata", () => {
		const metadata = extractStripeFinalizeMetadata({
			id: "evt_missing",
			type: "payment_intent.succeeded",
			data: { object: { id: "pi_1", metadata: {} } },
		});

		expect(metadata).toBeNull();
	});

	it("clamps webhook tolerance setting to configured bounds", () => {
		expect(clampStripeTolerance(0)).toBe(STRIPE_WEBHOOK_SIGNATURE.minToleranceSeconds);
		expect(clampStripeTolerance(9_999_999)).toBe(STRIPE_WEBHOOK_SIGNATURE.maxToleranceSeconds);
		expect(clampStripeTolerance("150")).toBe(150);
	});

	it("resolves webhook tolerance from KV settings", async () => {
		const ctx = {
			kv: {
				get: vi.fn(async (key: string) => {
					return key === "settings:stripeWebhookToleranceSeconds" ? "7200" : null;
				}),
			},
		} as never;

		await expect(resolveWebhookSignatureToleranceSeconds(ctx)).resolves.toBe(7_200);
	});

	it("falls back to default tolerance for malformed settings", async () => {
		const ctx = {
			kv: {
				get: vi.fn(async (key: string) => {
					return key === "settings:stripeWebhookToleranceSeconds" ? "not-a-number" : null;
				}),
			},
		} as never;

		await expect(resolveWebhookSignatureToleranceSeconds(ctx)).resolves.toBe(300);
	});

	it("builds finalization input from verified Stripe event metadata", async () => {
		finalizePaymentFromWebhook.mockResolvedValue({
			kind: "completed",
			orderId: "order_1",
		});

		const webhookSecret = "whsec_live_test";
		const body = rawStripeEventBody;
		const testTimestamp = 1_760_000_999;
		const sig = `t=${testTimestamp},v1=${await hashWithSecret(webhookSecret, testTimestamp, body)}`;
		const clock = vi.spyOn(Date, "now").mockReturnValue(testTimestamp * 1000);

		const ctx = {
			request: new Request("https://example.test/webhooks/stripe", {
				method: "POST",
				body,
				headers: {
					"content-length": String(body.length),
					"Stripe-Signature": sig,
				},
			}),
			input: JSON.parse(rawStripeEventBody),
			storage: {
				orders: {},
				webhookReceipts: {},
				paymentAttempts: {},
				inventoryLedger: {},
				inventoryStock: {},
			},
			kv: {
				get: vi.fn(async (key: string) => {
					if (key === "settings:stripeWebhookSecret") return webhookSecret;
					if (key === "settings:stripeWebhookToleranceSeconds") return "300";
					return null;
				}),
			},
			requestMeta: { ip: "127.0.0.1" },
			log: {
				info: () => undefined,
				warn: () => undefined,
				error: () => undefined,
				debug: () => undefined,
			},
		} as never;

		try {
			await stripeWebhookHandler(ctx);
		} finally {
			clock.mockRestore();
		}

		expect(finalizePaymentFromWebhook).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				orderId: "order_1",
				externalEventId: "evt_live_test",
				finalizeToken: "token_12345678901234",
				providerId: "stripe",
				correlationId: "evt_live_test",
			}),
		);
	});

	it("rejects Stripe event payloads missing metadata", async () => {
		const webhookSecret = "whsec_live_test";
		const body = JSON.stringify({
			id: "evt_invalid",
			type: "payment_intent.succeeded",
			data: { object: { id: "pi_1", metadata: {} } },
		});
		const testTimestamp = 1_760_000_999;
		const sig = `t=${testTimestamp},v1=${await hashWithSecret(webhookSecret, testTimestamp, body)}`;
		const clock = vi.spyOn(Date, "now").mockReturnValue(testTimestamp * 1000);

		try {
			await expect(
				stripeWebhookHandler({
					request: new Request("https://example.test/webhooks/stripe", {
						method: "POST",
						body,
						headers: {
							"content-length": String(body.length),
							"Stripe-Signature": sig,
						},
					}),
					input: JSON.parse(body),
					storage: {
						orders: {},
						webhookReceipts: {},
						paymentAttempts: {},
						inventoryLedger: {},
						inventoryStock: {},
					},
					kv: {
						get: vi.fn(async (key: string) => {
						if (key === "settings:stripeWebhookSecret") return webhookSecret;
							if (key === "settings:stripeWebhookToleranceSeconds") return "300";
							return null;
						}),
					},
					requestMeta: { ip: "127.0.0.1" },
					log: {
						info: () => undefined,
						warn: () => undefined,
						error: () => undefined,
						debug: () => undefined,
					},
				} as never),
			).rejects.toMatchObject({ code: "order_state_conflict" });
		} finally {
			clock.mockRestore();
		}
	});
});

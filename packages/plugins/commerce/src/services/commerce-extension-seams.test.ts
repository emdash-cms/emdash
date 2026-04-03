import { describe, expect, it } from "vitest";

import { createRecommendationsRoute, queryFinalizationState } from "./commerce-extension-seams.js";
import { webhookReceiptDocId } from "../orchestration/finalize-payment.js";
import type {
	StoredInventoryLedgerEntry,
	StoredInventoryStock,
	StoredOrder,
	StoredPaymentAttempt,
	StoredWebhookReceipt,
} from "../types.js";

interface StoredCollection<T> {
	get(id: string): Promise<T | null>;
	query(options?: {
		where?: Record<string, unknown>;
		limit?: number;
	}): Promise<{ items: Array<{ id: string; data: T }>; hasMore: boolean }>;
}

class MemCollection<T extends object> implements StoredCollection<T> {
	constructor(public readonly rows = new Map<string, T>()) {}

	async get(id: string): Promise<T | null> {
		const row = this.rows.get(id);
		return row ? structuredClone(row) : null;
	}

	async query(options?: { where?: Record<string, unknown>; limit?: number }) {
		const where = options?.where ?? {};
		const limit = options?.limit ?? 50;
		const items = [...this.rows]
			.filter(([_, row]) =>
				Object.entries(where).every(([field, value]) => (row as Record<string, unknown>)[field] === value),
			)
			.slice(0, limit)
			.map(([id, data]) => ({ id, data: structuredClone(data) }));
		return { items, hasMore: false };
	}
}

describe("createRecommendationsRoute", () => {
	const ctx = (input: { limit?: number }) =>
		({
			request: new Request("https://example.test/recommendations", { method: "POST" }),
			input,
		}) as never;

	it("returns enabled response from a recommendation resolver", async () => {
		const route = createRecommendationsRoute({
			providerId: "local-recs",
			resolver: async () => ({
				productIds: ["p1", "p2", "p1", ""],
				reason: "fallback",
			}),
		});

		const out = await route(ctx({ limit: 2 }));
		expect(out).toEqual({
			ok: true,
			enabled: true,
			strategy: "provider",
			productIds: ["p1", "p2"],
			providerId: "local-recs",
			reason: "fallback",
		});
	});

	it("degrades to disabled output when resolver is missing", async () => {
		const route = createRecommendationsRoute();
		const out = await route(ctx({ limit: 3 }));
		expect(out).toEqual({
			ok: true,
			enabled: false,
			strategy: "disabled",
			productIds: [],
			reason: "no_recommender_configured",
		});
	});
});

describe("queryFinalizationState", () => {
	const order: StoredOrder = {
		cartId: "cart_1",
		paymentPhase: "paid",
		currency: "USD",
		lineItems: [],
		totalMinor: 1000,
		createdAt: "2026-04-03T12:00:00.000Z",
		updatedAt: "2026-04-03T12:00:00.000Z",
	};

	const paymentAttempt: StoredPaymentAttempt = {
		orderId: "order_1",
		providerId: "stripe",
		status: "succeeded",
		createdAt: "2026-04-03T12:00:00.000Z",
		updatedAt: "2026-04-03T12:00:00.000Z",
	};

	const ledgerEntry: StoredInventoryLedgerEntry = {
		productId: "prod_1",
		variantId: "",
		delta: -1,
		referenceType: "order",
		referenceId: "order_1",
		createdAt: "2026-04-03T12:00:00.000Z",
	};

	const stock: StoredInventoryStock = {
		productId: "prod_1",
		variantId: "",
		version: 1,
		quantity: 1,
		updatedAt: "2026-04-03T12:00:00.000Z",
	};

	const receipt: StoredWebhookReceipt = {
		providerId: "stripe",
		externalEventId: "evt_1",
		orderId: "order_1",
		status: "processed",
		createdAt: "2026-04-03T12:00:00.000Z",
		updatedAt: "2026-04-03T12:00:00.000Z",
	};

	it("reflects finalized state across read-only service seam", async () => {
		const orders = new MemCollection(new Map([["order_1", order]]));
		const attempts = new MemCollection(new Map([["a1", paymentAttempt]]));
		const inventoryLedger = new MemCollection(new Map([["l1", ledgerEntry]]));
		const inventoryStock = new MemCollection(new Map([["s1", stock]]));
		const webhookReceipts = new MemCollection(new Map([[webhookReceiptDocId("stripe", "evt_1"), receipt]]));

		const out = await queryFinalizationState(
			{
				request: new Request("https://example.test/webhooks/stripe", { method: "POST" }),
				storage: {
					orders,
					paymentAttempts: attempts,
					inventoryLedger,
					inventoryStock,
					webhookReceipts,
				},
				requestMeta: { ip: "127.0.0.1" },
				log: {
					info: () => undefined,
					warn: () => undefined,
					error: () => undefined,
					debug: () => undefined,
				},
			} as never,
			{
				orderId: "order_1",
				providerId: "stripe",
				externalEventId: "evt_1",
			},
		);
		expect(out).toEqual({
			isInventoryApplied: true,
			isOrderPaid: true,
			isPaymentAttemptSucceeded: true,
			isReceiptProcessed: true,
		});
	});
});

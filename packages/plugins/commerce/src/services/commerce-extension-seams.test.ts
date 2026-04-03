import { describe, expect, it, vi } from "vitest";

import * as rateLimitKv from "../lib/rate-limit-kv.js";
import { webhookReceiptDocId } from "../orchestration/finalize-payment.js";
import { COMMERCE_LIMITS } from "../kernel/limits.js";
import type {
	StoredInventoryLedgerEntry,
	StoredInventoryStock,
	StoredOrder,
	StoredPaymentAttempt,
	StoredWebhookReceipt,
} from "../types.js";
import { createRecommendationsRoute, queryFinalizationState } from "./commerce-extension-seams.js";

interface StoredCollection<T> {
	get(id: string): Promise<T | null>;
	query(options?: {
		where?: Record<string, unknown>;
		limit?: number;
	}): Promise<{ items: Array<{ id: string; data: T }>; hasMore: boolean }>;
}

class MemKv {
	store = new Map<string, unknown>();

	async get<T>(key: string): Promise<T | null> {
		const row = this.store.get(key);
		return row === undefined ? null : (row as T);
	}

	async set(key: string, value: unknown): Promise<void> {
		this.store.set(key, value);
	}

	async delete(key: string): Promise<boolean> {
		return this.store.delete(key);
	}

	async list(): Promise<Array<{ key: string; value: unknown }>> {
		return Array.from(this.store.entries(), ([key, value]) => ({ key, value }));
	}
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
				Object.entries(where).every(
					([field, value]) => (row as Record<string, unknown>)[field] === value,
				),
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
		finalizeTokenHash: "placeholder-finalize-token-hash",
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
		const webhookReceipts = new MemCollection(
			new Map([[webhookReceiptDocId("stripe", "evt_1"), receipt]]),
		);

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
				kv: new MemKv(),
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
		expect(out).toMatchObject({
			isInventoryApplied: true,
			isOrderPaid: true,
			isPaymentAttemptSucceeded: true,
			isReceiptProcessed: true,
			receiptStatus: "processed",
			resumeState: "replay_processed",
		});
	});

	it("rate-limits finalization diagnostics per IP", async () => {
		const orders = new MemCollection(new Map([["order_1", order]]));
		const attempts = new MemCollection(new Map([["a1", paymentAttempt]]));
		const inventoryLedger = new MemCollection(new Map([["l1", ledgerEntry]]));
		const inventoryStock = new MemCollection(new Map([["s1", stock]]));
		const webhookReceipts = new MemCollection(
			new Map([[webhookReceiptDocId("stripe", "evt_1"), receipt]]),
		);
		const ctxBase = {
			request: new Request("https://example.test/diagnostics", { method: "POST" }),
			storage: {
				orders,
				paymentAttempts: attempts,
				inventoryLedger,
				inventoryStock,
				webhookReceipts,
			},
			requestMeta: { ip: "127.0.0.1" },
			kv: new MemKv(),
			log: {
				info: () => undefined,
				warn: () => undefined,
				error: () => undefined,
				debug: () => undefined,
			},
		} as never;

		const consumeSpy = vi
			.spyOn(rateLimitKv, "consumeKvRateLimit")
			.mockImplementation(async (options) => {
				expect(options.limit).toBe(COMMERCE_LIMITS.defaultFinalizationDiagnosticsPerIpPerWindow);
				expect(options.windowMs).toBe(COMMERCE_LIMITS.defaultRateWindowMs);
				expect(options.keySuffix.startsWith("finalize_diag:ip:")).toBe(true);
				return false;
			});
		const getSpy = vi.spyOn(orders, "get");
		await expect(
			queryFinalizationState(ctxBase, {
				orderId: "order_1",
				providerId: "stripe",
				externalEventId: "evt_1",
			}),
		).rejects.toMatchObject({ code: "rate_limited" });
		expect(consumeSpy).toHaveBeenCalledTimes(1);
		expect(getSpy).toHaveBeenCalledTimes(0);
		consumeSpy.mockRestore();
		getSpy.mockRestore();
	});

	it("coalesces concurrent identical diagnostics reads (single storage pass)", async () => {
		const orders = new MemCollection(new Map([["order_1", order]]));
		const attempts = new MemCollection(new Map([["a1", paymentAttempt]]));
		const inventoryLedger = new MemCollection(new Map([["l1", ledgerEntry]]));
		const inventoryStock = new MemCollection(new Map([["s1", stock]]));
		const webhookReceipts = new MemCollection(
			new Map([[webhookReceiptDocId("stripe", "evt_1"), receipt]]),
		);
		const getSpy = vi.spyOn(orders, "get");

		const ctxBase = {
			request: new Request("https://example.test/diagnostics", { method: "POST" }),
			storage: {
				orders,
				paymentAttempts: attempts,
				inventoryLedger,
				inventoryStock,
				webhookReceipts,
			},
			requestMeta: { ip: "10.0.0.2" },
			kv: new MemKv(),
			log: {
				info: () => undefined,
				warn: () => undefined,
				error: () => undefined,
				debug: () => undefined,
			},
		} as never;

		const input = {
			orderId: "order_1",
			providerId: "stripe",
			externalEventId: "evt_1",
		};

		await Promise.all([queryFinalizationState(ctxBase, input), queryFinalizationState(ctxBase, input)]);

		expect(getSpy.mock.calls.filter((c) => c[0] === "order_1").length).toBe(1);
		getSpy.mockRestore();
	});

	it("serves fresh-enough cached diagnostics without re-querying storage", async () => {
		const orders = new MemCollection(new Map([["order_1", order]]));
		const attempts = new MemCollection(new Map([["a1", paymentAttempt]]));
		const inventoryLedger = new MemCollection(new Map([["l1", ledgerEntry]]));
		const inventoryStock = new MemCollection(new Map([["s1", stock]]));
		const webhookReceipts = new MemCollection(
			new Map([[webhookReceiptDocId("stripe", "evt_1"), receipt]]),
		);
		const getSpy = vi.spyOn(orders, "get");

		const ctxBase = {
			request: new Request("https://example.test/diagnostics", { method: "POST" }),
			storage: {
				orders,
				paymentAttempts: attempts,
				inventoryLedger,
				inventoryStock,
				webhookReceipts,
			},
			requestMeta: { ip: "10.0.0.3" },
			kv: new MemKv(),
			log: {
				info: () => undefined,
				warn: () => undefined,
				error: () => undefined,
				debug: () => undefined,
			},
		} as never;

		const input = {
			orderId: "order_1",
			providerId: "stripe",
			externalEventId: "evt_1",
		};

		await queryFinalizationState(ctxBase, input);
		await queryFinalizationState(ctxBase, input);

		expect(getSpy.mock.calls.filter((c) => c[0] === "order_1").length).toBe(1);
		getSpy.mockRestore();
	});
});

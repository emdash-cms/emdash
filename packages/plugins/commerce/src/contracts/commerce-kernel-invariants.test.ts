import type { RouteContext } from "emdash";
import { describe, expect, it, vi } from "vitest";

import { COMMERCE_EXTENSION_SEAM_DOCS, COMMERCE_KERNEL_RULES } from "../catalog-extensibility.js";
import { webhookReceiptDocId } from "../orchestration/finalize-payment.js";
import {
	createRecommendationsRoute,
	queryFinalizationState,
} from "../services/commerce-extension-seams.js";
import type {
	StoredInventoryLedgerEntry,
	StoredInventoryStock,
	StoredOrder,
	StoredPaymentAttempt,
	StoredWebhookReceipt,
} from "../types.js";

type QueryCollection<T> = {
	get(id: string): Promise<T | null>;
	query(options?: { where?: Record<string, unknown>; limit?: number }): Promise<{
		items: Array<{ id: string; data: T }>;
		hasMore: boolean;
	}>;
};

function makeCollections() {
	const baseOrder: StoredOrder = {
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
	const ledgerRow: StoredInventoryLedgerEntry = {
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
	return {
		orders: new Map<string, StoredOrder>([["order_1", baseOrder]]),
		paymentAttempts: new Map<string, StoredPaymentAttempt>([["attempt_1", paymentAttempt]]),
		inventoryLedger: new Map<string, StoredInventoryLedgerEntry>([["ledger_1", ledgerRow]]),
		inventoryStock: new Map<string, StoredInventoryStock>([["stock_1", stock]]),
		webhookReceipts: new Map<string, StoredWebhookReceipt>([
			[webhookReceiptDocId("stripe", "evt_1"), receipt],
		]),
	};
}

function asCollection<T>(map: Map<string, T>): QueryCollection<T> {
	return {
		async get(id: string): Promise<T | null> {
			const row = map.get(id);
			return row ? structuredClone(row) : null;
		},
		async query(options?: { where?: Record<string, unknown>; limit?: number }) {
			const where = options?.where ?? {};
			const values = [...map.entries()].filter(([, row]) =>
				Object.entries(where).every(
					([field, value]) => (row as Record<string, unknown>)[field] === value,
				),
			);
			const items = values.slice(0, options?.limit ?? 50).map(([id, data]) => ({
				id,
				data: structuredClone(data),
			}));
			return { items, hasMore: false };
		},
	};
}

function toCollections() {
	const raw = makeCollections();
	return {
		orders: asCollection(raw.orders),
		paymentAttempts: asCollection(raw.paymentAttempts),
		inventoryLedger: asCollection(raw.inventoryLedger),
		inventoryStock: asCollection(raw.inventoryStock),
		webhookReceipts: asCollection(raw.webhookReceipts),
	};
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
		return [...this.store.entries()].map(([key, value]) => ({ key, value }));
	}
}

describe("commerce kernel invariants", () => {
	it("exports the kernel closure and read-only extension rules", () => {
		expect(COMMERCE_KERNEL_RULES).toEqual({
			no_kernel_bypass: "commerce:kernel-no-bypass",
			read_only_extensions: "commerce:read-only-extensions",
			service_entry_points_only: "commerce:service-entry-points-only",
		});
		expect(COMMERCE_EXTENSION_SEAM_DOCS.webhooks.mutability).toContain(
			"finalizePaymentFromWebhook",
		);
		expect(COMMERCE_EXTENSION_SEAM_DOCS.recommendations.mutability).toContain("No commerce writes");
	});

	it("keeps diagnostic helper read-only by construction", async () => {
		const ctx = {
			request: new Request("https://example.test/diagnostics", { method: "POST" }),
			storage: toCollections(),
			requestMeta: { ip: "127.0.0.1" },
			kv: new MemKv(),
			log: {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
			},
		} as unknown as RouteContext;

		const status = await queryFinalizationState(ctx, {
			orderId: "order_1",
			providerId: "stripe",
			externalEventId: "evt_1",
		});
		expect(status.receiptStatus).toBe("processed");
		expect(status.resumeState).toBe("replay_processed");
	});

	it("replays recommendation seam as read-only response surface", async () => {
		const route = createRecommendationsRoute({
			providerId: "acme-recs",
			resolver: async () => ({ productIds: ["p1", "p2"] }),
		});
		const out = await route({
			request: new Request("https://example.test/recommendations", {
				method: "POST",
				body: JSON.stringify({ limit: 3 }),
			}),
			input: { limit: 3 },
		} as never);

		expect(out).toEqual({
			ok: true,
			enabled: true,
			strategy: "provider",
			productIds: ["p1", "p2"],
			providerId: "acme-recs",
			reason: "provider_result",
		});
	});
});

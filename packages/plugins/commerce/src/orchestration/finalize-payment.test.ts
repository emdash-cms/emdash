import { describe, expect, it } from "vitest";

import { sha256Hex } from "../hash.js";
import type {
	StoredInventoryLedgerEntry,
	StoredInventoryStock,
	StoredOrder,
	StoredPaymentAttempt,
	StoredWebhookReceipt,
} from "../types.js";
import {
	finalizePaymentFromWebhook,
	inventoryStockDocId,
	receiptToView,
	webhookReceiptDocId,
} from "./finalize-payment.js";

/** Raw finalize token matching `FINALIZE_HASH` on test orders. */
const FINALIZE_RAW = "unit_test_finalize_secret_ok____________";
const FINALIZE_HASH = sha256Hex(FINALIZE_RAW);

type MemQueryOptions = {
	where?: Record<string, string | number | boolean | null>;
	limit?: number;
	cursor?: string;
	orderBy?: Partial<
		Record<
			"createdAt" | "orderId" | "providerId" | "status",
			"asc" | "desc"
		>
	>;
};

type MemPaginated<T> = { items: T[]; hasMore: boolean; cursor?: string };

class MemColl<T extends object> {
	constructor(private readonly rows = new Map<string, T>()) {}

	async get(id: string): Promise<T | null> {
		const row = this.rows.get(id);
		return row ? structuredClone(row) : null;
	}

	async put(id: string, data: T): Promise<void> {
		this.rows.set(id, structuredClone(data));
	}

	async query(options?: MemQueryOptions): Promise<MemPaginated<{ id: string; data: T }>> {
		const where = options?.where ?? {};
		const limit = Math.min(options?.limit ?? 50, 100);
		const orderBy = options?.orderBy;
		const items: Array<{ id: string; data: T }> = [];
		for (const [id, data] of this.rows) {
			const ok = Object.entries(where).every(([k, v]) => (data as Record<string, unknown>)[k] === v);
			if (ok) items.push({ id, data: structuredClone(data) });
		}
		if (orderBy && Object.keys(orderBy).length > 0) {
			items.sort((a, b) => {
				for (const [field, dir] of Object.entries(orderBy) as Array<
					["createdAt" | "orderId" | "providerId" | "status", "asc" | "desc"]
				>) {
					if (field !== "createdAt" && field !== "orderId" && field !== "providerId" && field !== "status")
						continue;
					const av = a.data[field];
					const bv = b.data[field];
					if (av === bv) continue;
					if (dir === "desc") return String(av).localeCompare(String(bv)) * -1;
					return String(av).localeCompare(String(bv));
				}
				return a.id.localeCompare(b.id);
			});
		}
		const trimmed = items.slice(0, limit);
		return { items: trimmed, hasMore: false };
	}
}

function portsFromState(state: {
	orders: Map<string, StoredOrder>;
	webhookReceipts: Map<string, StoredWebhookReceipt>;
	paymentAttempts: Map<string, StoredPaymentAttempt>;
	inventoryLedger: Map<string, StoredInventoryLedgerEntry>;
	inventoryStock: Map<string, StoredInventoryStock>;
}) {
	return {
		orders: new MemColl(state.orders),
		webhookReceipts: new MemColl(state.webhookReceipts),
		paymentAttempts: new MemColl(state.paymentAttempts),
		inventoryLedger: new MemColl(state.inventoryLedger),
		inventoryStock: new MemColl(state.inventoryStock),
	};
}

const now = "2026-04-02T12:00:00.000Z";

function baseOrder(overrides: Partial<StoredOrder> = {}): StoredOrder {
	return {
		cartId: "cart_1",
		paymentPhase: "payment_pending",
		currency: "USD",
		lineItems: [
			{
				productId: "p1",
				quantity: 2,
				inventoryVersion: 3,
				unitPriceMinor: 500,
			},
		],
		totalMinor: 1000,
		finalizeTokenHash: FINALIZE_HASH,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

describe("finalizePaymentFromWebhook", () => {
	it("finalizes: paid order, processed receipt, stock decrement, ledger row, attempt succeeded", async () => {
		const orderId = "order_1";
		const stockId = inventoryStockDocId("p1", "");
		const state = {
			orders: new Map([[orderId, baseOrder()]]),
			webhookReceipts: new Map<string, StoredWebhookReceipt>(),
			paymentAttempts: new Map<string, StoredPaymentAttempt>([
				[
					"pa_1",
					{
						orderId,
						providerId: "stripe",
						status: "pending",
						createdAt: now,
						updatedAt: now,
					},
				],
			]),
			inventoryLedger: new Map<string, StoredInventoryLedgerEntry>(),
			inventoryStock: new Map<string, StoredInventoryStock>([
				[
					stockId,
					{
						productId: "p1",
						variantId: "",
						version: 3,
						quantity: 10,
						updatedAt: now,
					},
				],
			]),
		};

		const ports = portsFromState(state);
		const ext = "evt_test_finalize";
		const res = await finalizePaymentFromWebhook(ports, {
			orderId,
			providerId: "stripe",
			externalEventId: ext,
			correlationId: "cid-1",
			finalizeToken: FINALIZE_RAW,
			nowIso: now,
		});

		expect(res).toEqual({ kind: "completed", orderId });

		const rid = webhookReceiptDocId("stripe", ext);
		const receipt = await ports.webhookReceipts.get(rid);
		expect(receipt?.status).toBe("processed");

		const order = await ports.orders.get(orderId);
		expect(order?.paymentPhase).toBe("paid");

		const stock = await ports.inventoryStock.get(stockId);
		expect(stock?.quantity).toBe(8);
		expect(stock?.version).toBe(4);

		const ledger = await ports.inventoryLedger.query({ limit: 10 });
		expect(ledger.items).toHaveLength(1);
		expect(ledger.items[0]!.data.delta).toBe(-2);
		expect(ledger.items[0]!.data.referenceId).toBe(orderId);

		const pa = await ports.paymentAttempts.get("pa_1");
		expect(pa?.status).toBe("succeeded");
	});

	it("merges duplicate SKU lines into one inventory movement", async () => {
		const orderId = "order_merge";
		const stockId = inventoryStockDocId("p1", "");
		const state = {
			orders: new Map([
				[
					orderId,
					baseOrder({
						lineItems: [
							{
								productId: "p1",
								quantity: 1,
								inventoryVersion: 3,
								unitPriceMinor: 500,
							},
							{
								productId: "p1",
								quantity: 1,
								inventoryVersion: 3,
								unitPriceMinor: 500,
							},
						],
						totalMinor: 1000,
					}),
				],
			]),
			webhookReceipts: new Map<string, StoredWebhookReceipt>(),
			paymentAttempts: new Map<string, StoredPaymentAttempt>(),
			inventoryLedger: new Map<string, StoredInventoryLedgerEntry>(),
			inventoryStock: new Map<string, StoredInventoryStock>([
				[
					stockId,
					{
						productId: "p1",
						variantId: "",
						version: 3,
						quantity: 10,
						updatedAt: now,
					},
				],
			]),
		};

		const ports = portsFromState(state);
		const res = await finalizePaymentFromWebhook(ports, {
			orderId,
			providerId: "stripe",
			externalEventId: "evt_merge_lines",
			correlationId: "cid",
			finalizeToken: FINALIZE_RAW,
			nowIso: now,
		});

		expect(res.kind).toBe("completed");
		const ledger = await ports.inventoryLedger.query({ limit: 10 });
		expect(ledger.items).toHaveLength(1);
		expect(ledger.items[0]!.data.delta).toBe(-2);
		const stock = await ports.inventoryStock.get(stockId);
		expect(stock?.quantity).toBe(8);
	});

	it("chooses the earliest pending provider-specific payment attempt", async () => {
		const orderId = "order_attempts";
		const stockId = inventoryStockDocId("p1", "");
		const state = {
			orders: new Map([
				[
					orderId,
					baseOrder({
						lineItems: [
							{
								productId: "p1",
								quantity: 1,
								inventoryVersion: 3,
								unitPriceMinor: 500,
							},
						],
					}),
				],
			]),
			webhookReceipts: new Map<string, StoredWebhookReceipt>(),
			paymentAttempts: new Map<string, StoredPaymentAttempt>([
				[
					"attempt_newest",
					{
						orderId,
						providerId: "stripe",
						status: "pending",
						createdAt: "2026-04-02T12:00:02.000Z",
						updatedAt: "2026-04-02T12:00:02.000Z",
					},
				],
				[
					"attempt_earliest",
					{
						orderId,
						providerId: "stripe",
						status: "pending",
						createdAt: "2026-04-02T12:00:00.000Z",
						updatedAt: "2026-04-02T12:00:00.000Z",
					},
				],
			]),
			inventoryLedger: new Map<string, StoredInventoryLedgerEntry>(),
			inventoryStock: new Map<string, StoredInventoryStock>([
				[
					stockId,
					{
						productId: "p1",
						variantId: "",
						version: 3,
						quantity: 10,
						updatedAt: now,
					},
				],
			]),
		};

		const ports = portsFromState(state);
		const res = await finalizePaymentFromWebhook(ports, {
			orderId,
			providerId: "stripe",
			externalEventId: "evt_attempts",
			correlationId: "cid",
			finalizeToken: FINALIZE_RAW,
			nowIso: now,
		});

		expect(res).toEqual({ kind: "completed", orderId });

		const chosen = await ports.paymentAttempts.get("attempt_earliest");
		const ignored = await ports.paymentAttempts.get("attempt_newest");
		expect(chosen?.status).toBe("succeeded");
		expect(ignored?.status).toBe("pending");
	});

	it("does not partially apply stock if preflight catches an invalid line", async () => {
		const orderId = "order_partial_fail";
		const state = {
			orders: new Map([
				[
					orderId,
					baseOrder({
						lineItems: [
							{
								productId: "p1",
								quantity: 1,
								inventoryVersion: 3,
								unitPriceMinor: 500,
							},
							{
								productId: "p2",
								variantId: "v1",
								quantity: 9,
								inventoryVersion: 3,
								unitPriceMinor: 250,
							},
						],
						totalMinor: 7250,
					}),
				],
			]),
			webhookReceipts: new Map<string, StoredWebhookReceipt>(),
			paymentAttempts: new Map<string, StoredPaymentAttempt>(),
			inventoryLedger: new Map<string, StoredInventoryLedgerEntry>(),
			inventoryStock: new Map<string, StoredInventoryStock>([
				[
					inventoryStockDocId("p1", ""),
					{
						productId: "p1",
						variantId: "",
						version: 3,
						quantity: 10,
						updatedAt: now,
					},
				],
				[
					inventoryStockDocId("p2", "v1"),
					{
						productId: "p2",
						variantId: "v1",
						version: 3,
						quantity: 2,
						updatedAt: now,
					},
				],
			]),
		};
		const ports = portsFromState(state);
		const extId = "evt_partial_fail";
		const result = await finalizePaymentFromWebhook(ports, {
			orderId,
			providerId: "stripe",
			externalEventId: extId,
			correlationId: "cid",
			finalizeToken: FINALIZE_RAW,
			nowIso: now,
		});
		expect(result).toMatchObject({
			kind: "api_error",
			error: { code: "PAYMENT_CONFLICT" },
		});

		const firstStock = await ports.inventoryStock.get(inventoryStockDocId("p1", ""));
		expect(firstStock?.quantity).toBe(10);
		const firstVersion = firstStock?.version;
		const secondStock = await ports.inventoryStock.get(inventoryStockDocId("p2", "v1"));
		expect(secondStock?.quantity).toBe(2);
		expect(secondStock?.version).toBe(3);
		expect(firstVersion).toBe(3);

		const ledger = await ports.inventoryLedger.query({ limit: 10 });
		expect(ledger.items).toHaveLength(0);
		const order = await ports.orders.get(orderId);
		expect(order?.paymentPhase).toBe("payment_conflict");
		const receipt = await ports.webhookReceipts.get(webhookReceiptDocId("stripe", extId));
		expect(receipt?.status).toBe("error");
	});

	it("rejects finalize when token is missing but order requires one", async () => {
		const orderId = "order_1";
		const state = {
			orders: new Map([[orderId, baseOrder()]]),
			webhookReceipts: new Map<string, StoredWebhookReceipt>(),
			paymentAttempts: new Map<string, StoredPaymentAttempt>(),
			inventoryLedger: new Map<string, StoredInventoryLedgerEntry>(),
			inventoryStock: new Map<string, StoredInventoryStock>(),
		};

		const res = await finalizePaymentFromWebhook(portsFromState(state), {
			orderId,
			providerId: "stripe",
			externalEventId: "evt_no_tok",
			correlationId: "cid",
			nowIso: now,
		});

		expect(res).toMatchObject({
			kind: "api_error",
			error: { code: "WEBHOOK_SIGNATURE_INVALID" },
		});
	});

	it("rejects finalize when token does not match", async () => {
		const orderId = "order_1";
		const state = {
			orders: new Map([[orderId, baseOrder()]]),
			webhookReceipts: new Map<string, StoredWebhookReceipt>(),
			paymentAttempts: new Map<string, StoredPaymentAttempt>(),
			inventoryLedger: new Map<string, StoredInventoryLedgerEntry>(),
			inventoryStock: new Map<string, StoredInventoryStock>(),
		};

		const res = await finalizePaymentFromWebhook(portsFromState(state), {
			orderId,
			providerId: "stripe",
			externalEventId: "evt_bad_tok",
			correlationId: "cid",
			finalizeToken: "wrong_token___________________________",
			nowIso: now,
		});

		expect(res).toMatchObject({
			kind: "api_error",
			error: { code: "WEBHOOK_SIGNATURE_INVALID" },
		});
	});

	it("duplicate externalEventId replay returns replay (200-class semantics)", async () => {
		const orderId = "order_1";
		const ext = "evt_dup";
		const rid = webhookReceiptDocId("stripe", ext);
		const state = {
			orders: new Map([[orderId, baseOrder()]]),
			webhookReceipts: new Map<string, StoredWebhookReceipt>([
				[
					rid,
					{
						providerId: "stripe",
						externalEventId: ext,
						orderId,
						status: "processed",
						createdAt: now,
						updatedAt: now,
					},
				],
			]),
			paymentAttempts: new Map<string, StoredPaymentAttempt>(),
			inventoryLedger: new Map<string, StoredInventoryLedgerEntry>(),
			inventoryStock: new Map<string, StoredInventoryStock>(),
		};

		const res = await finalizePaymentFromWebhook(portsFromState(state), {
			orderId,
			providerId: "stripe",
			externalEventId: ext,
			correlationId: "cid",
			nowIso: now,
		});

		expect(res).toEqual({ kind: "replay", reason: "webhook_receipt_processed" });
	});

	it("order already paid without receipt row still replays", async () => {
		const orderId = "order_1";
		const state = {
			orders: new Map([[orderId, baseOrder({ paymentPhase: "paid" })]]),
			webhookReceipts: new Map<string, StoredWebhookReceipt>(),
			paymentAttempts: new Map<string, StoredPaymentAttempt>(),
			inventoryLedger: new Map<string, StoredInventoryLedgerEntry>(),
			inventoryStock: new Map<string, StoredInventoryStock>(),
		};

		const res = await finalizePaymentFromWebhook(portsFromState(state), {
			orderId,
			providerId: "stripe",
			externalEventId: "evt_x",
			correlationId: "cid",
			nowIso: now,
		});

		expect(res.kind).toBe("replay");
		if (res.kind === "replay") expect(res.reason).toBe("order_already_paid");
	});

	it("pending receipt yields api_error ORDER_STATE_CONFLICT", async () => {
		const orderId = "order_1";
		const ext = "evt_pending";
		const rid = webhookReceiptDocId("stripe", ext);
		const state = {
			orders: new Map([[orderId, baseOrder()]]),
			webhookReceipts: new Map<string, StoredWebhookReceipt>([
				[
					rid,
					{
						providerId: "stripe",
						externalEventId: ext,
						orderId,
						status: "pending",
						createdAt: now,
						updatedAt: now,
					},
				],
			]),
			paymentAttempts: new Map<string, StoredPaymentAttempt>(),
			inventoryLedger: new Map<string, StoredInventoryLedgerEntry>(),
			inventoryStock: new Map<string, StoredInventoryStock>(),
		};

		const res = await finalizePaymentFromWebhook(portsFromState(state), {
			orderId,
			providerId: "stripe",
			externalEventId: ext,
			correlationId: "cid",
			nowIso: now,
		});

		expect(res).toMatchObject({
			kind: "api_error",
			error: { code: "ORDER_STATE_CONFLICT" },
		});
	});

	it("inventory version mismatch sets payment_conflict and returns INVENTORY_CHANGED", async () => {
		const orderId = "order_1";
		const stockId = inventoryStockDocId("p1", "");
		const state = {
			orders: new Map([[orderId, baseOrder()]]),
			webhookReceipts: new Map<string, StoredWebhookReceipt>(),
			paymentAttempts: new Map<string, StoredPaymentAttempt>(),
			inventoryLedger: new Map<string, StoredInventoryLedgerEntry>(),
			inventoryStock: new Map<string, StoredInventoryStock>([
				[
					stockId,
					{
						productId: "p1",
						variantId: "",
						version: 99,
						quantity: 10,
						updatedAt: now,
					},
				],
			]),
		};

		const ports = portsFromState(state);
		const ext = "evt_inv";
		const res = await finalizePaymentFromWebhook(ports, {
			orderId,
			providerId: "stripe",
			externalEventId: ext,
			correlationId: "cid",
			finalizeToken: FINALIZE_RAW,
			nowIso: now,
		});

		expect(res).toMatchObject({
			kind: "api_error",
			error: { code: "INVENTORY_CHANGED" },
		});
		const order = await ports.orders.get(orderId);
		expect(order?.paymentPhase).toBe("payment_conflict");
		const rid = webhookReceiptDocId("stripe", ext);
		const rec = await ports.webhookReceipts.get(rid);
		expect(rec?.status).toBe("error");
	});

	it("legacy orders without finalizeTokenHash still finalize when token omitted", async () => {
		const orderId = "order_legacy";
		const stockId = inventoryStockDocId("p1", "");
		const state = {
			orders: new Map([
				[
					orderId,
					baseOrder({
						finalizeTokenHash: undefined,
					}),
				],
			]),
			webhookReceipts: new Map<string, StoredWebhookReceipt>(),
			paymentAttempts: new Map<string, StoredPaymentAttempt>(),
			inventoryLedger: new Map<string, StoredInventoryLedgerEntry>(),
			inventoryStock: new Map<string, StoredInventoryStock>([
				[
					stockId,
					{
						productId: "p1",
						variantId: "",
						version: 3,
						quantity: 10,
						updatedAt: now,
					},
				],
			]),
		};

		const res = await finalizePaymentFromWebhook(portsFromState(state), {
			orderId,
			providerId: "stripe",
			externalEventId: "evt_legacy_ok",
			correlationId: "cid",
			nowIso: now,
		});

		expect(res).toEqual({ kind: "completed", orderId });
	});

	it("receiptToView maps storage rows for the kernel", () => {
		expect(receiptToView(null)).toEqual({ exists: false });
		expect(
			receiptToView({
				providerId: "stripe",
				externalEventId: "e",
				orderId: "o",
				status: "duplicate",
				createdAt: now,
				updatedAt: now,
			}),
		).toEqual({ exists: true, status: "duplicate" });
	});
});

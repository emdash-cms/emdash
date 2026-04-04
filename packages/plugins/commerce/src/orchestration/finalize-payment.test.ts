import { beforeAll, describe, expect, it } from "vitest";

import { sha256HexAsync } from "../lib/crypto-adapter.js";
import type {
	StoredInventoryLedgerEntry,
	StoredInventoryStock,
	StoredOrder,
	StoredPaymentAttempt,
	StoredWebhookReceipt,
} from "../types.js";
import {
	finalizePaymentFromWebhook,
	type FinalizePaymentPorts,
	inventoryStockDocId,
	queryFinalizationStatus,
	receiptToView,
	webhookReceiptDocId,
} from "./finalize-payment.js";

/** Raw finalize token matching `FINALIZE_HASH` on test orders. */
const FINALIZE_RAW = "unit_test_finalize_secret_ok____________";
let FINALIZE_HASH = "";

beforeAll(async () => {
	FINALIZE_HASH = await sha256HexAsync(FINALIZE_RAW);
});

type MemQueryOptions = {
	where?: Record<string, unknown>;
	limit?: number;
	cursor?: string;
	orderBy?: Partial<Record<"createdAt" | "orderId" | "providerId" | "status", "asc" | "desc">>;
};

type MemPaginated<T> = { items: T[]; hasMore: boolean; cursor?: string };

class MemColl<T extends object> {
	constructor(public readonly rows = new Map<string, T>()) {}

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
			const ok = Object.entries(where).every(
				([k, v]) => (data as Record<string, unknown>)[k] === v,
			);
			if (ok) items.push({ id, data: structuredClone(data) });
		}
		if (orderBy && Object.keys(orderBy).length > 0) {
			items.sort((a, b) => {
				for (const [field, dir] of Object.entries(orderBy) as Array<
					["createdAt" | "orderId" | "providerId" | "status", "asc" | "desc"]
				>) {
					if (
						field !== "createdAt" &&
						field !== "orderId" &&
						field !== "providerId" &&
						field !== "status"
					)
						continue;
					const rowA = a.data as Record<string, unknown>;
					const rowB = b.data as Record<string, unknown>;
					const av = rowA[field];
					const bv = rowB[field];
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

function withOneTimePutFailure<T extends object>(collection: MemColl<T>): MemColl<T> {
	let shouldFail = true;
	return {
		get rows() {
			return collection.rows;
		},
		get: (id: string) => collection.get(id),
		query: (options?: MemQueryOptions) => collection.query(options),
		put: async (id: string, data: T): Promise<void> => {
			if (shouldFail) {
				shouldFail = false;
				throw new Error("simulated storage write failure");
			}
			await collection.put(id, data);
		},
	} as MemColl<T>;
}

/** Succeeds on the first `succeedCount` puts, then fails exactly once. */
function withNthPutFailure<T extends object>(
	collection: MemColl<T>,
	failOnNth: number,
): MemColl<T> {
	let callCount = 0;
	let hasFailed = false;
	return {
		get rows() {
			return collection.rows;
		},
		get: (id: string) => collection.get(id),
		query: (options?: MemQueryOptions) => collection.query(options),
		put: async (id: string, data: T): Promise<void> => {
			callCount++;
			if (callCount === failOnNth && !hasFailed) {
				hasFailed = true;
				throw new Error("simulated storage write failure");
			}
			await collection.put(id, data);
		},
	} as MemColl<T>;
}

type MemCollWithPutIfAbsent<T extends object> = MemColl<T> & {
	putIfAbsent(id: string, data: T): Promise<boolean>;
};
type MemCollWithClaiming<T extends object> = MemCollWithPutIfAbsent<T> & {
	compareAndSwap(id: string, expectedVersion: string, data: T): Promise<boolean>;
};

function memCollWithPutIfAbsent<T extends object>(
	collection: MemColl<T>,
): MemCollWithClaiming<T> {
	return {
		get rows() {
			return collection.rows;
		},
		get: collection.get.bind(collection),
		query: collection.query.bind(collection),
		put: collection.put.bind(collection),
		putIfAbsent: async (id: string, data: T): Promise<boolean> => {
			if (collection.rows.has(id)) return false;
			collection.rows.set(id, structuredClone(data));
			return true;
		},
		compareAndSwap: async (id: string, expectedVersion: string, data: T): Promise<boolean> => {
			const existing = collection.rows.get(id);
			if (!existing) return false;
			const version = (existing as Record<string, unknown>).updatedAt;
			if (typeof version !== "string" || version !== expectedVersion) return false;
			collection.rows.set(id, structuredClone(data));
			return true;
		},
	} as MemCollWithClaiming<T>;
}

function stealWebhookClaim(webhookRows: Map<string, StoredWebhookReceipt>, receiptId: string): void {
	const current = webhookRows.get(receiptId);
	if (!current) return;
	webhookRows.set(receiptId, {
		...current,
		claimOwner: "other-worker",
		claimToken: "stolen-token",
		claimVersion: "2026-04-02T11:00:00.000Z",
	});
}

function portsFromState(state: {
	orders: Map<string, StoredOrder>;
	webhookReceipts: Map<string, StoredWebhookReceipt>;
	paymentAttempts: Map<string, StoredPaymentAttempt>;
	inventoryLedger: Map<string, StoredInventoryLedgerEntry>;
	inventoryStock: Map<string, StoredInventoryStock>;
}): FinalizePaymentPorts {
	return {
		orders: new MemColl(state.orders),
		webhookReceipts: new MemColl(state.webhookReceipts),
		paymentAttempts: new MemColl(state.paymentAttempts),
		inventoryLedger: new MemColl(state.inventoryLedger),
		inventoryStock: new MemColl(state.inventoryStock),
	} as FinalizePaymentPorts;
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
		expect(order?.paymentPhase).toBe("payment_pending");
		const receipt = await ports.webhookReceipts.get(webhookReceiptDocId("stripe", extId));
		expect(receipt?.status).toBe("error");
	});

	it("resumes safely when order persistence fails after inventory write", async () => {
		const orderId = "order_resume_order_fail";
		const extId = "evt_order_fail";
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
			]),
		};
		const basePorts = portsFromState(state) as FinalizePaymentPorts & {
			orders: MemColl<StoredOrder>;
		};
		const ports = {
			...basePorts,
			orders: withOneTimePutFailure(basePorts.orders as unknown as MemColl<StoredOrder>),
		};

		const first = await finalizePaymentFromWebhook(ports, {
			orderId,
			providerId: "stripe",
			externalEventId: extId,
			correlationId: "cid",
			finalizeToken: FINALIZE_RAW,
			nowIso: now,
		});
		expect(first).toMatchObject({ kind: "api_error", error: { code: "ORDER_STATE_CONFLICT" } });

		const stock = await basePorts.inventoryStock.get(inventoryStockDocId("p1", ""));
		expect(stock?.quantity).toBe(9);
		const ledger = await basePorts.inventoryLedger.query({ limit: 10 });
		expect(ledger.items).toHaveLength(1);

		const second = await finalizePaymentFromWebhook(basePorts, {
			orderId,
			providerId: "stripe",
			externalEventId: extId,
			correlationId: "cid",
			finalizeToken: FINALIZE_RAW,
			nowIso: now,
		});
		expect(second).toEqual({ kind: "completed", orderId });

		const paidOrder = await basePorts.orders.get(orderId);
		expect(paidOrder?.paymentPhase).toBe("paid");
		const receipt = await basePorts.webhookReceipts.get(webhookReceiptDocId("stripe", extId));
		expect(receipt?.status).toBe("processed");
	});

	it("retries safely when payment-attempt finalization fails", async () => {
		const orderId = "order_resume_attempt_fail";
		const extId = "evt_attempt_fail";
		const state = {
			orders: new Map([[orderId, baseOrder()]]),
			webhookReceipts: new Map<string, StoredWebhookReceipt>(),
			paymentAttempts: new Map<string, StoredPaymentAttempt>([
				[
					"pa_retry",
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
					inventoryStockDocId("p1", ""),
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
		const basePorts = {
			...ports,
			paymentAttempts: withOneTimePutFailure(
				ports.paymentAttempts as unknown as MemColl<StoredPaymentAttempt>,
			),
		} as typeof ports;

		const first = await finalizePaymentFromWebhook(basePorts, {
			orderId,
			providerId: "stripe",
			externalEventId: extId,
			correlationId: "cid",
			finalizeToken: FINALIZE_RAW,
			nowIso: now,
		});
		expect(first).toMatchObject({ kind: "api_error", error: { code: "ORDER_STATE_CONFLICT" } });

		const paidOrder = await ports.orders.get(orderId);
		expect(paidOrder?.paymentPhase).toBe("paid");

		const pendingAttempt = await ports.paymentAttempts.query({
			where: { orderId: orderId, providerId: "stripe", status: "pending" },
			limit: 5,
		});
		expect(pendingAttempt.items).toHaveLength(1);

		const receipt = await ports.webhookReceipts.get(webhookReceiptDocId("stripe", extId));
		expect(receipt?.status).toBe("pending");

		const second = await finalizePaymentFromWebhook(ports, {
			orderId,
			providerId: "stripe",
			externalEventId: extId,
			correlationId: "cid",
			finalizeToken: FINALIZE_RAW,
			nowIso: now,
		});
		expect(second).toEqual({ kind: "completed", orderId });

		const succeededAttempt = await ports.paymentAttempts.query({
			where: { orderId: orderId, providerId: "stripe", status: "succeeded" },
			limit: 5,
		});
		expect(succeededAttempt.items).toHaveLength(1);
		const retryReceipt = await ports.webhookReceipts.get(webhookReceiptDocId("stripe", extId));
		expect(retryReceipt?.status).toBe("processed");
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
			finalizeToken: "",
			nowIso: now,
		});

		expect(res).toMatchObject({
			kind: "api_error",
			error: { code: "ORDER_TOKEN_REQUIRED" },
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
			error: { code: "ORDER_TOKEN_INVALID" },
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

		const ports = portsFromState(state);
		const res = await finalizePaymentFromWebhook(ports, {
			orderId,
			providerId: "stripe",
			externalEventId: ext,
			correlationId: "cid",
			finalizeToken: "",
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
			finalizeToken: "",
			nowIso: now,
		});

		expect(res.kind).toBe("replay");
		if (res.kind === "replay") expect(res.reason).toBe("order_already_paid");
	});

	it("resumes completion for a paid order with a pending webhook receipt", async () => {
		const orderId = "order_paid_pending";
		const ext = "evt_paid_pending";
		const rid = webhookReceiptDocId("stripe", ext);
		const state = {
			orders: new Map([
				[
					orderId,
					baseOrder({
						paymentPhase: "paid",
						lineItems: [
							{
								productId: "p1",
								quantity: 2,
								inventoryVersion: 3,
								unitPriceMinor: 500,
							},
						],
					}),
				],
			]),
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
			paymentAttempts: new Map<string, StoredPaymentAttempt>([
				[
					"pa_paid",
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
			inventoryStock: new Map<string, StoredInventoryStock>(),
		};
		const ports = portsFromState(state);
		const res = await finalizePaymentFromWebhook(ports, {
			orderId,
			providerId: "stripe",
			externalEventId: ext,
			correlationId: "cid",
			finalizeToken: FINALIZE_RAW,
			nowIso: now,
		});

		expect(res).toEqual({ kind: "completed", orderId });
		const paidOrder = await ports.orders.get(orderId);
		expect(paidOrder?.paymentPhase).toBe("paid");
		const receipt = await ports.webhookReceipts.get(rid);
		expect(receipt?.status).toBe("processed");
		const attempt = await ports.paymentAttempts.get("pa_paid");
		expect(attempt?.status).toBe("succeeded");
		const final = await queryFinalizationStatus(ports, orderId, "stripe", ext);
		expect(final).toMatchObject({
			resumeState: "replay_processed",
			receiptStatus: "processed",
			isInventoryApplied: false,
			isOrderPaid: true,
			isPaymentAttemptSucceeded: true,
			isReceiptProcessed: true,
		});
	});

	it("pending receipt still requires finalize token", async () => {
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

		const ports = portsFromState(state);
		const res = await finalizePaymentFromWebhook(ports, {
			orderId,
			providerId: "stripe",
			externalEventId: ext,
			correlationId: "cid",
			finalizeToken: "",
			nowIso: now,
		});

		expect(res).toMatchObject({
			kind: "api_error",
			error: { code: "ORDER_TOKEN_REQUIRED" },
		});
		const pendingStatus = await queryFinalizationStatus(ports, orderId, "stripe", ext);
		expect(pendingStatus).toMatchObject({
			receiptStatus: "pending",
			isInventoryApplied: false,
			isOrderPaid: false,
			isPaymentAttemptSucceeded: false,
			isReceiptProcessed: false,
			resumeState: "pending_inventory",
		});
	});

	it("keeps a pending event resumable when finalize token is initially missing", async () => {
		const orderId = "order_1";
		const ext = "evt_pending_retry";
		const rid = webhookReceiptDocId("stripe", ext);
		const stockId = inventoryStockDocId("p1", "");
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
			paymentAttempts: new Map<string, StoredPaymentAttempt>([
				[
					"pa_pending_retry",
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
		const first = await finalizePaymentFromWebhook(ports, {
			orderId,
			providerId: "stripe",
			externalEventId: ext,
			correlationId: "cid",
			finalizeToken: "",
			nowIso: now,
		});
		expect(first).toMatchObject({
			kind: "api_error",
			error: { code: "ORDER_TOKEN_REQUIRED" },
		});
		const preRetryStatus = await queryFinalizationStatus(ports, orderId, "stripe", ext);
		expect(preRetryStatus).toMatchObject({
			receiptStatus: "pending",
			isInventoryApplied: false,
			isOrderPaid: false,
			isPaymentAttemptSucceeded: false,
			isReceiptProcessed: false,
			resumeState: "pending_inventory",
		});
		const pending = await ports.webhookReceipts.get(rid);
		expect(pending?.status).toBe("pending");

		const second = await finalizePaymentFromWebhook(ports, {
			orderId,
			providerId: "stripe",
			externalEventId: ext,
			correlationId: "cid",
			finalizeToken: FINALIZE_RAW,
			nowIso: now,
		});
		expect(second).toEqual({ kind: "completed", orderId });

		const final = await queryFinalizationStatus(ports, orderId, "stripe", ext);
		expect(final).toMatchObject({
			receiptStatus: "processed",
			isInventoryApplied: true,
			isOrderPaid: true,
			isPaymentAttemptSucceeded: true,
			isReceiptProcessed: true,
			resumeState: "replay_processed",
		});

		const stock = await ports.inventoryStock.get(stockId);
		expect(stock?.version).toBe(4);
		expect(stock?.quantity).toBe(8);
		const ledger = await ports.inventoryLedger.query({ limit: 10 });
		expect(ledger.items).toHaveLength(1);
	});

	it("marks pending receipt as error when order leaves finalizable phase between reads", async () => {
		const orderId = "order_state_conflict";
		const ext = "evt_state_conflict";
		const rid = webhookReceiptDocId("stripe", ext);
		const state = {
			orders: new Map<string, StoredOrder>([[orderId, baseOrder()]]),
			webhookReceipts: new Map<string, StoredWebhookReceipt>(),
			paymentAttempts: new Map<string, StoredPaymentAttempt>(),
			inventoryLedger: new Map<string, StoredInventoryLedgerEntry>(),
			inventoryStock: new Map<string, StoredInventoryStock>(),
		};

		const basePorts = portsFromState(state) as FinalizePaymentPorts & {
			orders: MemColl<StoredOrder>;
		};
		let getCount = 0;
		const orderStateMutatingOrders: MemColl<StoredOrder> = {
			...basePorts.orders,
			get: async (id: string) => {
				const row = await basePorts.orders.get(id);
				getCount += 1;
				if (row && getCount === 2 && id === orderId) {
					const drifted = { ...row, paymentPhase: "processing" as const };
					basePorts.orders.rows.set(id, drifted);
					return drifted;
				}
				return row;
			},
		};

		const ports = { ...basePorts, orders: orderStateMutatingOrders } as FinalizePaymentPorts;
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
			error: { code: "ORDER_STATE_CONFLICT" },
		});

		const receipt = await basePorts.webhookReceipts.get(rid);
		expect(receipt?.status).toBe("error");
		expect(receipt?.errorCode).toBe("ORDER_STATE_CONFLICT");
	});

	it("marks pending receipt as error when order disappears between reads", async () => {
		const orderId = "order_disappears";
		const ext = "evt_disappears";
		const rid = webhookReceiptDocId("stripe", ext);
		const state = {
			orders: new Map<string, StoredOrder>([[orderId, baseOrder()]]),
			webhookReceipts: new Map<string, StoredWebhookReceipt>(),
			paymentAttempts: new Map<string, StoredPaymentAttempt>(),
			inventoryLedger: new Map<string, StoredInventoryLedgerEntry>(),
			inventoryStock: new Map<string, StoredInventoryStock>(),
		};

		const basePorts = portsFromState(state) as FinalizePaymentPorts & {
			orders: MemColl<StoredOrder>;
		};
		let orderReadCount = 0;
		const disappearingOrders: MemColl<StoredOrder> = {
			...basePorts.orders,
			get: async (id: string) => {
				const row = await basePorts.orders.get(id);
				orderReadCount += 1;
				if (id === orderId && orderReadCount >= 2) {
					basePorts.orders.rows.delete(id);
					return null;
				}
				return row;
			},
		} as MemColl<StoredOrder>;

		const ports = { ...basePorts, orders: disappearingOrders } as FinalizePaymentPorts;
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
			error: { code: "ORDER_NOT_FOUND", message: "Order not found" },
		});

		const receipt = await basePorts.webhookReceipts.get(rid);
		expect(receipt?.status).toBe("error");
		expect(receipt?.errorCode).toBe("ORDER_NOT_FOUND");
		expect(receipt?.errorDetails).toMatchObject({ orderId, correlationId: "cid" });
		const order = await basePorts.orders.get(orderId);
		expect(order).toBeNull();
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
		const status = await queryFinalizationStatus(ports, orderId, "stripe", ext);
		expect(status).toMatchObject({
			receiptStatus: "error",
			isInventoryApplied: false,
			isOrderPaid: false,
			isPaymentAttemptSucceeded: false,
			isReceiptProcessed: false,
			receiptErrorCode: "INVENTORY_CHANGED",
			resumeState: "error",
		});
		const order = await ports.orders.get(orderId);
		expect(order?.paymentPhase).toBe("payment_pending");
		const rid = webhookReceiptDocId("stripe", ext);
		const rec = await ports.webhookReceipts.get(rid);
		expect(rec?.status).toBe("error");
		expect(rec?.errorCode).toBe("INVENTORY_CHANGED");
	});

	it("terminalized inventory mismatch receipt blocks same-event replay", async () => {
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
		const ext = "evt_inv_terminal";
		const first = await finalizePaymentFromWebhook(ports, {
			orderId,
			providerId: "stripe",
			externalEventId: ext,
			correlationId: "cid",
			finalizeToken: FINALIZE_RAW,
			nowIso: now,
		});
		expect(first).toMatchObject({
			kind: "api_error",
			error: { code: "INVENTORY_CHANGED" },
		});

		const second = await finalizePaymentFromWebhook(ports, {
			orderId,
			providerId: "stripe",
			externalEventId: ext,
			correlationId: "cid",
			finalizeToken: FINALIZE_RAW,
			nowIso: now,
		});
		expect(second).toMatchObject({
			kind: "api_error",
			error: { code: "ORDER_STATE_CONFLICT" },
		});

		const rid = webhookReceiptDocId("stripe", ext);
		const receipt = await ports.webhookReceipts.get(rid);
		expect(receipt?.status).toBe("error");
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

	it("resumes correctly when ledger write succeeds but stock write fails", async () => {
		/**
		 * Sharpest inventory edge: `inventoryLedger.put` succeeds but
		 * `inventoryStock.put` throws. The receipt is left `pending`, ledger row
		 * exists, stock is still at the pre-mutation version.
		 *
		 * On retry the reconcile pass in `applyInventoryMutations` must detect
		 * "ledger exists, stock.version === inventoryVersion" and finish the stock
		 * write without re-writing the ledger.
		 */
		const orderId = "order_ledger_ok_stock_fail";
		const extId = "evt_stock_fail";
		const stockDocId = inventoryStockDocId("p1", "");
		const state = {
			orders: new Map([
				[
					orderId,
					baseOrder({
						lineItems: [{ productId: "p1", quantity: 2, inventoryVersion: 3, unitPriceMinor: 500 }],
					}),
				],
			]),
			webhookReceipts: new Map<string, StoredWebhookReceipt>(),
			paymentAttempts: new Map<string, StoredPaymentAttempt>([
				[
					"pa_lsf",
					{ orderId, providerId: "stripe", status: "pending", createdAt: now, updatedAt: now },
				],
			]),
			inventoryLedger: new Map<string, StoredInventoryLedgerEntry>(),
			inventoryStock: new Map<string, StoredInventoryStock>([
				[stockDocId, { productId: "p1", variantId: "", version: 3, quantity: 10, updatedAt: now }],
			]),
		};

		const basePorts = portsFromState(state);
		// Wrap inventoryStock so the first put (stock update) fails.
		const ports = {
			...basePorts,
			inventoryStock: withOneTimePutFailure(
				basePorts.inventoryStock as unknown as MemColl<StoredInventoryStock>,
			),
		} as FinalizePaymentPorts;

		// First attempt: ledger write succeeds, stock write throws (hard storage error).
		await expect(
			finalizePaymentFromWebhook(ports, {
				orderId,
				providerId: "stripe",
				externalEventId: extId,
				correlationId: "cid",
				finalizeToken: FINALIZE_RAW,
				nowIso: now,
			}),
		).rejects.toThrow("simulated storage write failure");
		const interrupted = await queryFinalizationStatus(basePorts, orderId, "stripe", extId);
		expect(interrupted).toMatchObject({
			receiptStatus: "pending",
			isInventoryApplied: true,
			isOrderPaid: false,
			isPaymentAttemptSucceeded: false,
			isReceiptProcessed: false,
			resumeState: "pending_order",
		});

		// After first attempt: ledger row must exist, stock must NOT yet be updated.
		const ledgerAfterFirst = await basePorts.inventoryLedger.query({ limit: 10 });
		expect(ledgerAfterFirst.items).toHaveLength(1);
		const stockAfterFirst = await basePorts.inventoryStock.get(stockDocId);
		expect(stockAfterFirst?.version).toBe(3); // stock unchanged
		expect(stockAfterFirst?.quantity).toBe(10); // quantity unchanged

		// Second attempt on basePorts (stock write works): reconcile pass should
		// detect ledger-exists + stock.version === inventoryVersion and finish it.
		const second = await finalizePaymentFromWebhook(basePorts, {
			orderId,
			providerId: "stripe",
			externalEventId: extId,
			correlationId: "cid",
			finalizeToken: FINALIZE_RAW,
			nowIso: now,
		});
		expect(second).toEqual({ kind: "completed", orderId });

		const stockAfterRetry = await basePorts.inventoryStock.get(stockDocId);
		expect(stockAfterRetry?.version).toBe(4); // stock updated
		expect(stockAfterRetry?.quantity).toBe(8); // 10 - 2

		const ledgerAfterRetry = await basePorts.inventoryLedger.query({ limit: 10 });
		expect(ledgerAfterRetry.items).toHaveLength(1); // no duplicate ledger row

		const status = await queryFinalizationStatus(basePorts, orderId, "stripe", extId);
		expect(status).toMatchObject({
			isInventoryApplied: true,
			isOrderPaid: true,
			isPaymentAttemptSucceeded: true,
			isReceiptProcessed: true,
			receiptStatus: "processed",
			resumeState: "replay_processed",
		});
	});

	it("retries safely when payment attempt finalization write fails", async () => {
		const orderId = "order_pending_attempt";
		const extId = "evt_attempt_fail";
		const stockId = inventoryStockDocId("p1", "");
		const state = {
			orders: new Map([
				[
					orderId,
					baseOrder({
						lineItems: [{ productId: "p1", quantity: 2, inventoryVersion: 3, unitPriceMinor: 500 }],
					}),
				],
			]),
			webhookReceipts: new Map<string, StoredWebhookReceipt>(),
			paymentAttempts: new Map<string, StoredPaymentAttempt>([
				[
					"pa_retry_attempt",
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

		const basePorts = portsFromState(state) as FinalizePaymentPorts & {
			paymentAttempts: MemColl<StoredPaymentAttempt>;
		};
		const ports = {
			...basePorts,
			paymentAttempts: withNthPutFailure(basePorts.paymentAttempts, 1),
		} as FinalizePaymentPorts;

		const first = await finalizePaymentFromWebhook(ports, {
			orderId,
			providerId: "stripe",
			externalEventId: extId,
			correlationId: "cid",
			finalizeToken: FINALIZE_RAW,
			nowIso: now,
		});
		expect(first).toMatchObject({
			kind: "api_error",
			error: { code: "ORDER_STATE_CONFLICT" },
		});
		const pendingAttempt = await queryFinalizationStatus(basePorts, orderId, "stripe", extId);
		expect(pendingAttempt).toMatchObject({
			receiptStatus: "pending",
			isInventoryApplied: true,
			isOrderPaid: true,
			isPaymentAttemptSucceeded: false,
			isReceiptProcessed: false,
			resumeState: "pending_attempt",
		});

		const attemptBeforeRetry = await basePorts.paymentAttempts.get("pa_retry_attempt");
		expect(attemptBeforeRetry?.status).toBe("pending");
		const stockAfterFirst = await basePorts.inventoryStock.get(stockId);
		expect(stockAfterFirst?.version).toBe(4);
		expect(stockAfterFirst?.quantity).toBe(8);

		const receipt = await basePorts.webhookReceipts.get(webhookReceiptDocId("stripe", extId));
		expect(receipt?.status).toBe("pending");

		const second = await finalizePaymentFromWebhook(basePorts, {
			orderId,
			providerId: "stripe",
			externalEventId: extId,
			correlationId: "cid",
			finalizeToken: FINALIZE_RAW,
			nowIso: now,
		});
		expect(second).toEqual({ kind: "completed", orderId });

		const attemptAfterRetry = await basePorts.paymentAttempts.get("pa_retry_attempt");
		expect(attemptAfterRetry?.status).toBe("succeeded");
		const status = await queryFinalizationStatus(basePorts, orderId, "stripe", extId);
		expect(status).toMatchObject({
			receiptStatus: "processed",
			isInventoryApplied: true,
			isOrderPaid: true,
			isPaymentAttemptSucceeded: true,
			isReceiptProcessed: true,
			resumeState: "replay_processed",
		});

		const ledger = await basePorts.inventoryLedger.query({ limit: 10 });
		expect(ledger.items).toHaveLength(1);
	});

	it("completes on retry when final receipt processed write fails", async () => {
		/**
		 * Everything succeeds (inventory, order→paid, payment attempt→succeeded)
		 * but the final `webhookReceipts.put(status: "processed")` throws.
		 *
		 * Receipt is left `pending`. On retry: order is already paid, inventory
		 * is already applied, attempt is already succeeded. Only the receipt
		 * write needs to complete.
		 */
		const orderId = "order_receipt_fail";
		const extId = "evt_receipt_fail";
		const state = {
			orders: new Map([[orderId, baseOrder()]]),
			webhookReceipts: new Map<string, StoredWebhookReceipt>(),
			paymentAttempts: new Map<string, StoredPaymentAttempt>([
				[
					"pa_rf",
					{ orderId, providerId: "stripe", status: "pending", createdAt: now, updatedAt: now },
				],
			]),
			inventoryLedger: new Map<string, StoredInventoryLedgerEntry>(),
			inventoryStock: new Map<string, StoredInventoryStock>([
				[
					inventoryStockDocId("p1", ""),
					{ productId: "p1", variantId: "", version: 3, quantity: 10, updatedAt: now },
				],
			]),
		};

		const basePorts = portsFromState(state);
		// The second webhookReceipts.put (status→processed) fails; the first
		// (status→pending) must succeed so the receipt is left in pending state.
		const ports = {
			...basePorts,
			webhookReceipts: withNthPutFailure(
				basePorts.webhookReceipts as unknown as MemColl<StoredWebhookReceipt>,
				2,
			),
		};

		// First attempt: throws when writing status→processed.
		await expect(
			finalizePaymentFromWebhook(ports, {
				orderId,
				providerId: "stripe",
				externalEventId: extId,
				correlationId: "cid",
				finalizeToken: FINALIZE_RAW,
				nowIso: now,
			}),
		).rejects.toThrow("simulated storage write failure");

		// After first attempt: all side effects must be done except receipt→processed.
		const status = await queryFinalizationStatus(basePorts, orderId, "stripe", extId);
		expect(status.isInventoryApplied).toBe(true);
		expect(status.isOrderPaid).toBe(true);
		expect(status.isPaymentAttemptSucceeded).toBe(true);
		expect(status.isReceiptProcessed).toBe(false); // this is the unfinished bit
		expect(status).toMatchObject({
			resumeState: "pending_receipt",
			receiptStatus: "pending",
		});

		const pendingReceipt = await basePorts.webhookReceipts.get(
			webhookReceiptDocId("stripe", extId),
		);
		expect(pendingReceipt?.status).toBe("pending");

		// Second attempt on basePorts: should complete just the receipt write.
		const second = await finalizePaymentFromWebhook(basePorts, {
			orderId,
			providerId: "stripe",
			externalEventId: extId,
			correlationId: "cid",
			finalizeToken: FINALIZE_RAW,
			nowIso: now,
		});
		expect(second).toEqual({ kind: "completed", orderId });

		const finalStatus = await queryFinalizationStatus(basePorts, orderId, "stripe", extId);
		expect(finalStatus).toMatchObject({
			isInventoryApplied: true,
			isOrderPaid: true,
			isPaymentAttemptSucceeded: true,
			isReceiptProcessed: true,
			receiptStatus: "processed",
			resumeState: "replay_processed",
		});
	});

	it("reports event_unknown when order is fully settled but receipt row is missing", async () => {
		const orderId = "order_event_unknown";
		const extId = "evt_missing_receipt";
		const state = {
			orders: new Map([
				[
					orderId,
					baseOrder({
						paymentPhase: "paid",
					}),
				],
			]),
			webhookReceipts: new Map<string, StoredWebhookReceipt>(),
			paymentAttempts: new Map<string, StoredPaymentAttempt>([
				[
					"pa_event_unknown",
					{ orderId, providerId: "stripe", status: "succeeded", createdAt: now, updatedAt: now },
				],
			]),
			inventoryLedger: new Map<string, StoredInventoryLedgerEntry>([
				[
					"ledger_event_unknown",
					{
						productId: "p1",
						variantId: "",
						delta: -2,
						referenceType: "order",
						referenceId: orderId,
						createdAt: now,
					},
				],
			]),
			inventoryStock: new Map<string, StoredInventoryStock>(),
		};

		const ports = portsFromState(state);
		const status = await queryFinalizationStatus(ports, orderId, "stripe", extId);
		expect(status).toMatchObject({
			receiptStatus: "missing",
			isInventoryApplied: true,
			isOrderPaid: true,
			isPaymentAttemptSucceeded: true,
			isReceiptProcessed: false,
			resumeState: "event_unknown",
		});
	});

	it("concurrent same-event finalize: preserves single terminal side effect and replay-safe follow-up", async () => {
		/**
		 * Two concurrent deliveries of the same gateway event should converge on one
		 * terminalized payment state and remain replay-safe once finalized.
		 */
		const orderId = "order_concurrent";
		const extId = "evt_concurrent";
		const stockDocId = inventoryStockDocId("p1", "");
		const state = {
			orders: new Map([
				[
					orderId,
					baseOrder({
						lineItems: [{ productId: "p1", quantity: 2, inventoryVersion: 3, unitPriceMinor: 500 }],
					}),
				],
			]),
			webhookReceipts: new Map<string, StoredWebhookReceipt>(),
			paymentAttempts: new Map<string, StoredPaymentAttempt>([
				[
					"pa_concurrent",
					{ orderId, providerId: "stripe", status: "pending", createdAt: now, updatedAt: now },
				],
			]),
			inventoryLedger: new Map<string, StoredInventoryLedgerEntry>(),
			inventoryStock: new Map<string, StoredInventoryStock>([
				[stockDocId, { productId: "p1", variantId: "", version: 3, quantity: 10, updatedAt: now }],
			]),
		};

		const ports = portsFromState(state);
		const logs = Array<{ level: "info" | "warn"; message: string; data?: unknown }>();
		const portsWithLogs = {
			...ports,
			log: {
				info: (message: string, data?: unknown) => logs.push({ level: "info", message, data }),
				warn: (message: string, data?: unknown) => logs.push({ level: "warn", message, data }),
			},
		};
		const input = {
			orderId,
			providerId: "stripe",
			externalEventId: extId,
			correlationId: "cid",
			finalizeToken: FINALIZE_RAW,
			nowIso: now,
		};

		const [r1, r2] = await Promise.all([
			finalizePaymentFromWebhook(portsWithLogs, input),
			finalizePaymentFromWebhook(portsWithLogs, input),
		]);

		// In-process race windows may drive both through `proceed`; idempotent writes
		// should still converge on one terminal state.
		expect(r1).toEqual({ kind: "completed", orderId });
		expect(r2).toEqual({ kind: "completed", orderId });

		// Stock is decremented exactly once (idempotent overwrites, same values).
		const finalStock = await ports.inventoryStock.get(stockDocId);
		expect(finalStock?.version).toBe(4);
		expect(finalStock?.quantity).toBe(8); // 10 - 2

		// Ledger has exactly one entry (both wrote the same id).
		const ledger = await ports.inventoryLedger.query({ limit: 10 });
		expect(ledger.items).toHaveLength(1);

		const replay = await finalizePaymentFromWebhook(portsWithLogs, input);
		expect(replay).toEqual({ kind: "replay", reason: "webhook_receipt_processed" });

		const finalStatus = await queryFinalizationStatus(portsWithLogs, orderId, "stripe", extId);
		expect(finalStatus).toMatchObject({
			receiptStatus: "processed",
			isInventoryApplied: true,
			isOrderPaid: true,
			isPaymentAttemptSucceeded: true,
			isReceiptProcessed: true,
			resumeState: "replay_processed",
		});

		expect(logs.some((entry) => entry.message === "commerce.finalize.inventory_reconcile")).toBe(true);
		expect(logs.some((entry) => entry.message === "commerce.finalize.payment_attempt_update_attempt")).toBe(true);
		expect(logs.some((entry) => entry.message === "commerce.finalize.completed")).toBe(true);
		expect(logs.some((entry) => entry.message === "commerce.finalize.noop")).toBe(true);
	});

	it("claim-aware same-event concurrency: only one worker applies side effects", async () => {
		const orderId = "order_claim_once";
		const extId = "evt_claim_once";
		const stockDocId = inventoryStockDocId("p1", "");
		const state = {
			orders: new Map([
				[
					orderId,
					baseOrder({
						lineItems: [{ productId: "p1", quantity: 2, inventoryVersion: 3, unitPriceMinor: 500 }],
					}),
				],
			]),
			webhookReceipts: new Map<string, StoredWebhookReceipt>(),
			paymentAttempts: new Map<string, StoredPaymentAttempt>([
				[
					"pa_claim_once",
					{ orderId, providerId: "stripe", status: "pending", createdAt: now, updatedAt: now },
				],
			]),
			inventoryLedger: new Map<string, StoredInventoryLedgerEntry>(),
			inventoryStock: new Map<string, StoredInventoryStock>([
				[stockDocId, { productId: "p1", variantId: "", version: 3, quantity: 10, updatedAt: now }],
			]),
		};

		const basePorts = portsFromState(state);
		const ports = {
			...basePorts,
			webhookReceipts: memCollWithPutIfAbsent(basePorts.webhookReceipts as MemColl<StoredWebhookReceipt>),
		} as FinalizePaymentPorts;
		const input = {
			orderId,
			providerId: "stripe",
			externalEventId: extId,
			correlationId: "cid",
			finalizeToken: FINALIZE_RAW,
			nowIso: now,
		};

		const [first, second] = await Promise.all([
			finalizePaymentFromWebhook(ports, input),
			finalizePaymentFromWebhook(ports, input),
		]);
		const outcomes = [first, second].map((result) => result.kind);
		expect(outcomes).toContain("completed");
		expect(outcomes).toContain("replay");

		const stock = await ports.inventoryStock.get(stockDocId);
		expect(stock?.version).toBe(4);
		expect(stock?.quantity).toBe(8);

		const ledger = await ports.inventoryLedger.query({ limit: 10 });
		expect(ledger.items).toHaveLength(1);

		const receipt = await ports.webhookReceipts.get(webhookReceiptDocId("stripe", extId));
		expect(receipt?.status).toBe("processed");
	});

	it("does not steal a fresh claimed in-flight webhook receipt", async () => {
		const orderId = "order_fresh_claim";
		const extId = "evt_fresh_claim";
		const stockDocId = inventoryStockDocId("p1", "");
		const freshClaimExpiresAt = "2026-04-02T12:00:30.000Z";
		const state = {
			orders: new Map([
				[
					orderId,
					baseOrder({
						lineItems: [{ productId: "p1", quantity: 2, inventoryVersion: 3, unitPriceMinor: 500 }],
					}),
				],
			]),
			webhookReceipts: new Map<string, StoredWebhookReceipt>([
				[
					webhookReceiptDocId("stripe", extId),
					{
						providerId: "stripe",
						externalEventId: extId,
						orderId,
						status: "pending",
						correlationId: "cid",
						createdAt: now,
						updatedAt: now,
						claimState: "claimed",
						claimOwner: "other-worker",
						claimToken: "other-token",
						claimVersion: now,
						claimExpiresAt: freshClaimExpiresAt,
					},
				],
			]),
			paymentAttempts: new Map<string, StoredPaymentAttempt>([
				[
					"pa_fresh_claim",
					{ orderId, providerId: "stripe", status: "pending", createdAt: now, updatedAt: now },
				],
			]),
			inventoryLedger: new Map<string, StoredInventoryLedgerEntry>(),
			inventoryStock: new Map<string, StoredInventoryStock>([
				[stockDocId, { productId: "p1", variantId: "", version: 3, quantity: 10, updatedAt: now }],
			]),
		};

		const basePorts = portsFromState(state);
		const ports = {
			...basePorts,
			webhookReceipts: memCollWithPutIfAbsent(basePorts.webhookReceipts as MemColl<StoredWebhookReceipt>),
		} as FinalizePaymentPorts;
		const res = await finalizePaymentFromWebhook(ports, {
			orderId,
			providerId: "stripe",
			externalEventId: extId,
			correlationId: "cid",
			finalizeToken: FINALIZE_RAW,
			nowIso: now,
		});

		expect(res).toEqual({ kind: "replay", reason: "webhook_receipt_in_flight" });

		const order = await ports.orders.get(orderId);
		expect(order?.paymentPhase).toBe("payment_pending");
		const receipt = await ports.webhookReceipts.get(webhookReceiptDocId("stripe", extId));
		expect(receipt?.claimState).toBe("claimed");
	});

	it("reclaims a stale claimed webhook receipt and completes finalize", async () => {
		const orderId = "order_stale_claim";
		const extId = "evt_stale_claim";
		const stockDocId = inventoryStockDocId("p1", "");
		const state = {
			orders: new Map([
				[
					orderId,
					baseOrder({
						lineItems: [{ productId: "p1", quantity: 2, inventoryVersion: 3, unitPriceMinor: 500 }],
					}),
				],
			]),
			webhookReceipts: new Map<string, StoredWebhookReceipt>([
				[
					webhookReceiptDocId("stripe", extId),
					{
						providerId: "stripe",
						externalEventId: extId,
						orderId,
						status: "pending",
						correlationId: "cid",
						createdAt: "2026-04-02T11:00:00.000Z",
						updatedAt: now,
						claimState: "claimed",
						claimOwner: "other-worker",
						claimToken: "other-token",
						claimVersion: "2026-04-02T11:00:00.000Z",
						claimExpiresAt: "2026-04-02T11:59:00.000Z",
					},
				],
			]),
			paymentAttempts: new Map<string, StoredPaymentAttempt>([
				[
					"pa_stale_claim",
					{ orderId, providerId: "stripe", status: "pending", createdAt: now, updatedAt: now },
				],
			]),
			inventoryLedger: new Map<string, StoredInventoryLedgerEntry>(),
			inventoryStock: new Map<string, StoredInventoryStock>([
				[stockDocId, { productId: "p1", variantId: "", version: 3, quantity: 10, updatedAt: now }],
			]),
		};

		const basePorts = portsFromState(state);
		const ports = {
			...basePorts,
			webhookReceipts: memCollWithPutIfAbsent(basePorts.webhookReceipts as MemColl<StoredWebhookReceipt>),
		} as FinalizePaymentPorts;

		const res = await finalizePaymentFromWebhook(ports, {
			orderId,
			providerId: "stripe",
			externalEventId: extId,
			correlationId: "cid",
			finalizeToken: FINALIZE_RAW,
			nowIso: now,
		});

		expect(res).toEqual({ kind: "completed", orderId });
		const receipt = await ports.webhookReceipts.get(webhookReceiptDocId("stripe", extId));
		expect(receipt?.status).toBe("processed");
		expect(receipt?.claimState).toBe("released");
	});

	it("aborts before order/payment writes when claim is stolen after inventory step", async () => {
		const orderId = "order_claim_stolen_before_finalize_writes";
		const extId = "evt_claim_stolen_before_finalize_writes";
		const state = {
			orders: new Map([
				[
					orderId,
					baseOrder({
						lineItems: [],
						totalMinor: 0,
					}),
				],
			]),
			webhookReceipts: new Map<string, StoredWebhookReceipt>(),
			paymentAttempts: new Map<string, StoredPaymentAttempt>([
				[
					"pa_claim_stolen_before_finalize_writes",
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
			inventoryStock: new Map<string, StoredInventoryStock>(),
		};

		const basePorts = portsFromState(state);
		const webhookRows = basePorts.webhookReceipts.rows;
		const webhookReceipts = memCollWithPutIfAbsent(basePorts.webhookReceipts as MemColl<StoredWebhookReceipt>);
		const rid = webhookReceiptDocId("stripe", extId);
		const ports = {
			...basePorts,
			inventoryLedger: {
				rows: basePorts.inventoryLedger.rows,
				get: basePorts.inventoryLedger.get.bind(basePorts.inventoryLedger),
				put: basePorts.inventoryLedger.put.bind(basePorts.inventoryLedger),
				query: async (options: Parameters<MemColl<StoredInventoryLedgerEntry>["query"]>[0]) => {
					const result = await basePorts.inventoryLedger.query(options);
					stealWebhookClaim(webhookRows, rid);
					return result;
				},
			},
			webhookReceipts,
		} as FinalizePaymentPorts;

		const res = await finalizePaymentFromWebhook(ports, {
			orderId,
			providerId: "stripe",
			externalEventId: extId,
			correlationId: "cid",
			finalizeToken: FINALIZE_RAW,
			nowIso: now,
		});

		expect(res).toEqual({ kind: "replay", reason: "webhook_receipt_in_flight" });

		const order = await basePorts.orders.get(orderId);
		expect(order?.paymentPhase).toBe("payment_pending");
		const pa = await basePorts.paymentAttempts.get("pa_claim_stolen_before_finalize_writes");
		expect(pa?.status).toBe("pending");
		const ledger = await basePorts.inventoryLedger.query({ limit: 10 });
		expect(ledger.items).toHaveLength(0);
		const receipt = await basePorts.webhookReceipts.get(rid);
		expect(receipt?.status).toBe("pending");
		expect(receipt?.claimOwner).toBe("other-worker");
	});

	it("aborts before payment attempt update when claim is stolen during order write", async () => {
		const orderId = "order_claim_stolen_during_order_write";
		const extId = "evt_claim_stolen_during_order_write";
		const stockDocId = inventoryStockDocId("p1", "");
		const state = {
			orders: new Map([
				[
					orderId,
					baseOrder({
						lineItems: [{ productId: "p1", quantity: 2, inventoryVersion: 3, unitPriceMinor: 500 }],
					}),
				],
			]),
			webhookReceipts: new Map<string, StoredWebhookReceipt>(),
			paymentAttempts: new Map<string, StoredPaymentAttempt>([
				[
					"pa_claim_stolen_during_order_write",
					{ orderId, providerId: "stripe", status: "pending", createdAt: now, updatedAt: now },
				],
			]),
			inventoryLedger: new Map<string, StoredInventoryLedgerEntry>(),
			inventoryStock: new Map<string, StoredInventoryStock>([
				[stockDocId, { productId: "p1", variantId: "", version: 3, quantity: 10, updatedAt: now }],
			]),
		};

		const basePorts = portsFromState(state);
		const webhookRows = basePorts.webhookReceipts.rows;
		const webhookReceipts = memCollWithPutIfAbsent(basePorts.webhookReceipts as MemColl<StoredWebhookReceipt>);
		const rid = webhookReceiptDocId("stripe", extId);
		const ports = {
			...basePorts,
			orders: {
				rows: basePorts.orders.rows,
				get: basePorts.orders.get.bind(basePorts.orders),
				query: basePorts.orders.query.bind(basePorts.orders),
				put: async (id: string, data: StoredOrder): Promise<void> => {
					stealWebhookClaim(webhookRows, rid);
					await basePorts.orders.put(id, data);
				},
			},
			webhookReceipts,
		} as FinalizePaymentPorts;

		const res = await finalizePaymentFromWebhook(ports, {
			orderId,
			providerId: "stripe",
			externalEventId: extId,
			correlationId: "cid",
			finalizeToken: FINALIZE_RAW,
			nowIso: now,
		});

		expect(res).toEqual({ kind: "replay", reason: "webhook_receipt_in_flight" });

		const order = await basePorts.orders.get(orderId);
		expect(order?.paymentPhase).toBe("paid");
		const pa = await basePorts.paymentAttempts.get("pa_claim_stolen_during_order_write");
		expect(pa?.status).toBe("pending");
		const stock = await basePorts.inventoryStock.get(stockDocId);
		expect(stock?.quantity).toBe(8);
		const ledger = await basePorts.inventoryLedger.query({ limit: 10 });
		expect(ledger.items).toHaveLength(1);
		const receipt = await basePorts.webhookReceipts.get(rid);
		expect(receipt?.status).toBe("pending");
		expect(receipt?.claimOwner).toBe("other-worker");
	});

	it("aborts before processed receipt when claim is stolen during payment attempt write", async () => {
		const orderId = "order_claim_stolen_during_attempt_write";
		const extId = "evt_claim_stolen_during_attempt_write";
		const stockDocId = inventoryStockDocId("p1", "");
		const state = {
			orders: new Map([
				[
					orderId,
					baseOrder({
						lineItems: [{ productId: "p1", quantity: 2, inventoryVersion: 3, unitPriceMinor: 500 }],
					}),
				],
			]),
			webhookReceipts: new Map<string, StoredWebhookReceipt>(),
			paymentAttempts: new Map<string, StoredPaymentAttempt>([
				[
					"pa_claim_stolen_during_attempt_write",
					{ orderId, providerId: "stripe", status: "pending", createdAt: now, updatedAt: now },
				],
			]),
			inventoryLedger: new Map<string, StoredInventoryLedgerEntry>(),
			inventoryStock: new Map<string, StoredInventoryStock>([
				[stockDocId, { productId: "p1", variantId: "", version: 3, quantity: 10, updatedAt: now }],
			]),
		};

		const basePorts = portsFromState(state);
		const webhookRows = basePorts.webhookReceipts.rows;
		const webhookReceipts = memCollWithPutIfAbsent(basePorts.webhookReceipts as MemColl<StoredWebhookReceipt>);
		const rid = webhookReceiptDocId("stripe", extId);
		const ports = {
			...basePorts,
			paymentAttempts: {
				rows: basePorts.paymentAttempts.rows,
				get: basePorts.paymentAttempts.get.bind(basePorts.paymentAttempts),
				query: basePorts.paymentAttempts.query.bind(basePorts.paymentAttempts),
				put: async (id: string, data: StoredPaymentAttempt): Promise<void> => {
					stealWebhookClaim(webhookRows, rid);
					await basePorts.paymentAttempts.put(id, data);
				},
			},
			webhookReceipts,
		} as FinalizePaymentPorts;

		const res = await finalizePaymentFromWebhook(ports, {
			orderId,
			providerId: "stripe",
			externalEventId: extId,
			correlationId: "cid",
			finalizeToken: FINALIZE_RAW,
			nowIso: now,
		});

		expect(res).toEqual({ kind: "replay", reason: "webhook_receipt_in_flight" });

		const order = await basePorts.orders.get(orderId);
		expect(order?.paymentPhase).toBe("paid");
		const pa = await basePorts.paymentAttempts.get("pa_claim_stolen_during_attempt_write");
		expect(pa?.status).toBe("succeeded");
		const stock = await basePorts.inventoryStock.get(stockDocId);
		expect(stock?.quantity).toBe(8);
		const ledger = await basePorts.inventoryLedger.query({ limit: 10 });
		expect(ledger.items).toHaveLength(1);
		const receipt = await basePorts.webhookReceipts.get(rid);
		expect(receipt?.status).toBe("pending");
		expect(receipt?.claimOwner).toBe("other-worker");
	});

	it("aborts when another worker marks receipt processed during order write", async () => {
		const orderId = "order_claim_processed_during_order_write";
		const extId = "evt_claim_processed_during_order_write";
		const stockDocId = inventoryStockDocId("p1", "");
		const state = {
			orders: new Map([
				[
					orderId,
					baseOrder({
						lineItems: [{ productId: "p1", quantity: 2, inventoryVersion: 3, unitPriceMinor: 500 }],
					}),
				],
			]),
			webhookReceipts: new Map<string, StoredWebhookReceipt>(),
			paymentAttempts: new Map<string, StoredPaymentAttempt>([
				[
					"pa_claim_processed_during_order_write",
					{ orderId, providerId: "stripe", status: "pending", createdAt: now, updatedAt: now },
				],
			]),
			inventoryLedger: new Map<string, StoredInventoryLedgerEntry>(),
			inventoryStock: new Map<string, StoredInventoryStock>([
				[stockDocId, { productId: "p1", variantId: "", version: 3, quantity: 10, updatedAt: now }],
			]),
		};

		const basePorts = portsFromState(state);
		const webhookRows = basePorts.webhookReceipts.rows;
		const webhookReceipts = memCollWithPutIfAbsent(basePorts.webhookReceipts as MemColl<StoredWebhookReceipt>);
		const rid = webhookReceiptDocId("stripe", extId);
		const ports = {
			...basePorts,
			orders: {
				rows: basePorts.orders.rows,
				get: basePorts.orders.get.bind(basePorts.orders),
				query: basePorts.orders.query.bind(basePorts.orders),
				put: async (id: string, data: StoredOrder): Promise<void> => {
					await basePorts.orders.put(id, data);
					const current = webhookRows.get(rid);
					if (current) {
						webhookRows.set(rid, {
							...current,
							status: "processed",
							claimState: "released",
							claimOwner: undefined,
							claimToken: undefined,
							claimVersion: undefined,
							claimExpiresAt: undefined,
							updatedAt: now,
						});
					}
				},
			},
			webhookReceipts,
		} as FinalizePaymentPorts;

		const res = await finalizePaymentFromWebhook(ports, {
			orderId,
			providerId: "stripe",
			externalEventId: extId,
			correlationId: "cid",
			finalizeToken: FINALIZE_RAW,
			nowIso: now,
		});

		expect(res).toEqual({ kind: "replay", reason: "webhook_receipt_processed" });

		const order = await basePorts.orders.get(orderId);
		expect(order?.paymentPhase).toBe("paid");
		const pa = await basePorts.paymentAttempts.get("pa_claim_processed_during_order_write");
		expect(pa?.status).toBe("pending");
		const stock = await basePorts.inventoryStock.get(stockDocId);
		expect(stock?.quantity).toBe(8);
		const ledger = await basePorts.inventoryLedger.query({ limit: 10 });
		expect(ledger.items).toHaveLength(1);
		const receipt = await basePorts.webhookReceipts.get(rid);
		expect(receipt?.status).toBe("processed");
		expect(receipt?.claimState).toBe("released");
	});

	it("pending receipt with unparseable updatedAt is treated as stale claim and finalizes", async () => {
		const orderId = "order_bad_receipt_ts";
		const extId = "evt_bad_receipt_ts";
		const rid = webhookReceiptDocId("stripe", extId);
		const stockDocId = inventoryStockDocId("p1", "");
		const state = {
			orders: new Map([
				[
					orderId,
					baseOrder({
						lineItems: [{ productId: "p1", quantity: 1, inventoryVersion: 3, unitPriceMinor: 500 }],
					}),
				],
			]),
			webhookReceipts: new Map<string, StoredWebhookReceipt>([
				[
					rid,
					{
						providerId: "stripe",
						externalEventId: extId,
						orderId,
						status: "pending",
						correlationId: "cid",
						createdAt: now,
						updatedAt: "not-an-iso-timestamp",
					},
				],
			]),
			paymentAttempts: new Map<string, StoredPaymentAttempt>([
				[
					"pa_bad_ts",
					{ orderId, providerId: "stripe", status: "pending", createdAt: now, updatedAt: now },
				],
			]),
			inventoryLedger: new Map<string, StoredInventoryLedgerEntry>(),
			inventoryStock: new Map<string, StoredInventoryStock>([
				[stockDocId, { productId: "p1", variantId: "", version: 3, quantity: 10, updatedAt: now }],
			]),
		};

		const basePorts = portsFromState(state);
		const ports = {
			...basePorts,
			webhookReceipts: memCollWithPutIfAbsent(basePorts.webhookReceipts as MemColl<StoredWebhookReceipt>),
		} as FinalizePaymentPorts;

		const res = await finalizePaymentFromWebhook(ports, {
			orderId,
			providerId: "stripe",
			externalEventId: extId,
			correlationId: "cid",
			finalizeToken: FINALIZE_RAW,
			nowIso: now,
		});

		expect(res).toEqual({ kind: "completed", orderId });
		const receipt = await ports.webhookReceipts.get(rid);
		expect(receipt?.status).toBe("processed");
	});

	it("stress: many in-process duplicate same-event finalizations converge on one inventory result", async () => {
		const orderId = "order_concurrent_many";
		const extId = "evt_concurrent_many";
		const stockDocId = inventoryStockDocId("p1", "");
		const state = {
			orders: new Map([
				[
					orderId,
					baseOrder({
						lineItems: [{ productId: "p1", quantity: 2, inventoryVersion: 3, unitPriceMinor: 500 }],
					}),
				],
			]),
			webhookReceipts: new Map<string, StoredWebhookReceipt>(),
			paymentAttempts: new Map<string, StoredPaymentAttempt>([
				[
					"pa_concurrent_many",
					{ orderId, providerId: "stripe", status: "pending", createdAt: now, updatedAt: now },
				],
			]),
			inventoryLedger: new Map<string, StoredInventoryLedgerEntry>(),
			inventoryStock: new Map<string, StoredInventoryStock>([
				[stockDocId, { productId: "p1", variantId: "", version: 3, quantity: 10, updatedAt: now }],
			]),
		};

		const ports = portsFromState(state);
		const input = {
			orderId,
			providerId: "stripe",
			externalEventId: extId,
			correlationId: "cid",
			finalizeToken: FINALIZE_RAW,
			nowIso: now,
		};

		const results = await Promise.all(
			Array.from({ length: 8 }, (_index) => finalizePaymentFromWebhook(ports, input)),
		);
		expect(results).toHaveLength(8);
		for (const result of results) {
			expect(result).toEqual({ kind: "completed", orderId });
		}

		const finalStock = await ports.inventoryStock.get(stockDocId);
		expect(finalStock?.version).toBe(4);
		expect(finalStock?.quantity).toBe(8);

		const ledger = await ports.inventoryLedger.query({ limit: 10 });
		expect(ledger.items).toHaveLength(1);

		const receipt = await ports.webhookReceipts.get(webhookReceiptDocId("stripe", extId));
		expect(receipt?.status).toBe("processed");
	});
});

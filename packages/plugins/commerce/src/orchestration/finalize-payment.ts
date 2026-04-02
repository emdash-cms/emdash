/**
 * Storage-backed payment finalization (webhook path).
 *
 * Ordering follows architecture §20.5: claim a `webhookReceipts` row (`pending`) →
 * finalize inventory + order → mark receipt `processed`.
 *
 * `decidePaymentFinalize` interprets the read model only; this module performs writes.
 *
 * **Concurrency:** Plugin storage has no multi-document transactions and `put` upserts on id
 * only. Two concurrent deliveries of the *same* gateway event can still double-apply
 * inventory until the platform exposes insert-if-not-exists or conditional writes. Receipt
 * + `finalizeTokenHash` reduce *cross-order* abuse; duplicate concurrent same-event remains
 * a documented residual risk.
 */

import { ulid } from "ulidx";

import type { CommerceErrorCode } from "../kernel/errors.js";
import {
	decidePaymentFinalize,
	type WebhookReceiptView,
} from "../kernel/finalize-decision.js";
import { equalSha256HexDigest, sha256Hex } from "../hash.js";
import { mergeLineItemsBySku } from "../lib/merge-line-items.js";
import type {
	StoredInventoryLedgerEntry,
	StoredInventoryStock,
	StoredOrder,
	StoredPaymentAttempt,
	StoredWebhookReceipt,
	OrderLineItem,
} from "../types.js";
import type { CommerceApiErrorInput } from "../kernel/api-errors.js";

type FinalizeQueryPage<T> = {
	items: Array<{ id: string; data: T }>;
	hasMore: boolean;
	cursor?: string;
};

export type FinalizeLogPort = {
	info(message: string, data?: unknown): void;
	warn(message: string, data?: unknown): void;
};

/** Narrow storage surface for tests and `ctx.storage` (structural match). */
export type FinalizeCollection<T> = {
	get(id: string): Promise<T | null>;
	put(id: string, data: T): Promise<void>;
};

export type FinalizePaymentAttemptCollection = FinalizeCollection<StoredPaymentAttempt> & {
	query(options?: { where?: Record<string, unknown>; limit?: number }): Promise<FinalizeQueryPage<StoredPaymentAttempt>>;
};

export type FinalizePaymentPorts = {
	orders: FinalizeCollection<StoredOrder>;
	webhookReceipts: FinalizeCollection<StoredWebhookReceipt>;
	paymentAttempts: FinalizePaymentAttemptCollection;
	inventoryLedger: FinalizeCollection<StoredInventoryLedgerEntry>;
	inventoryStock: FinalizeCollection<StoredInventoryStock>;
	log?: FinalizeLogPort;
};

export type FinalizeWebhookInput = {
	orderId: string;
	providerId: string;
	externalEventId: string;
	correlationId: string;
	/** Required when `StoredOrder.finalizeTokenHash` is set. */
	finalizeToken?: string;
	/** Inject clock in tests. */
	nowIso?: string;
};

export type FinalizeWebhookResult =
	| { kind: "completed"; orderId: string }
	| { kind: "replay"; reason: string }
	| { kind: "api_error"; error: CommerceApiErrorInput };

class InventoryFinalizeError extends Error {
	constructor(
		public code: CommerceErrorCode,
		message: string,
		public details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "InventoryFinalizeError";
	}
}

/** Stable document id for a webhook receipt (primary-key dedupe per event). */
export function webhookReceiptDocId(providerId: string, externalEventId: string): string {
	return `wr:${sha256Hex(`${providerId}\n${externalEventId}`)}`;
}

export function inventoryStockDocId(productId: string, variantId: string): string {
	return `stock:${sha256Hex(`${productId}\n${variantId}`)}`;
}

export function receiptToView(stored: StoredWebhookReceipt | null): WebhookReceiptView {
	if (!stored) return { exists: false };
	return { exists: true, status: stored.status };
}

function noopToResult(
	decision: Extract<ReturnType<typeof decidePaymentFinalize>, { action: "noop" }>,
	orderId: string,
): FinalizeWebhookResult {
	if (decision.httpStatus === 200) {
		return { kind: "replay", reason: decision.reason };
	}
	return {
		kind: "api_error",
		error: {
			code: "ORDER_STATE_CONFLICT",
			message: noopConflictMessage(decision.reason),
			details: { reason: decision.reason, orderId },
		},
	};
}

function noopConflictMessage(reason: string): string {
	switch (reason) {
		case "webhook_pending":
			return "Webhook receipt is still pending processing";
		case "webhook_error":
			return "Webhook receipt is in a terminal error state";
		case "order_not_finalizable":
			return "Order is not in a finalizable payment state";
		default:
			return "Finalize could not proceed";
	}
}

function verifyFinalizeToken(order: StoredOrder, token: string | undefined): FinalizeWebhookResult | null {
	const expected = order.finalizeTokenHash;
	if (!expected) return null;
	if (!token) {
		return {
			kind: "api_error",
			error: {
				code: "WEBHOOK_SIGNATURE_INVALID",
				message: "finalizeToken is required to finalize this order",
			},
		};
	}
	const digest = sha256Hex(token);
	if (!equalSha256HexDigest(digest, expected)) {
		return {
			kind: "api_error",
			error: {
				code: "WEBHOOK_SIGNATURE_INVALID",
				message: "Invalid finalize token for this order",
			},
		};
	}
	return null;
}

async function applyInventoryForOrder(
	ports: FinalizePaymentPorts,
	order: StoredOrder,
	orderId: string,
	nowIso: string,
): Promise<void> {
	let merged: OrderLineItem[];
	try {
		merged = mergeLineItemsBySku(order.lineItems);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new InventoryFinalizeError("ORDER_STATE_CONFLICT", msg, { orderId });
	}

	for (const line of merged) {
		const stockId = inventoryStockDocId(line.productId, line.variantId ?? "");
		const stock = await ports.inventoryStock.get(stockId);
		if (!stock) {
			throw new InventoryFinalizeError(
				"PRODUCT_UNAVAILABLE",
				`No inventory record for product ${line.productId}`,
				{ productId: line.productId },
			);
		}
		if (stock.version !== line.inventoryVersion) {
			throw new InventoryFinalizeError(
				"INVENTORY_CHANGED",
				"Inventory version changed since checkout",
				{ productId: line.productId, expected: line.inventoryVersion, current: stock.version },
			);
		}
		if (stock.quantity < line.quantity) {
			throw new InventoryFinalizeError(
				"INSUFFICIENT_STOCK",
				"Not enough stock to finalize order",
				{ productId: line.productId, requested: line.quantity, available: stock.quantity },
			);
		}

		const ledgerId = ulid();
		const entry: StoredInventoryLedgerEntry = {
			productId: line.productId,
			variantId: line.variantId ?? "",
			delta: -line.quantity,
			referenceType: "order",
			referenceId: orderId,
			createdAt: nowIso,
		};
		await ports.inventoryLedger.put(ledgerId, entry);

		const next: StoredInventoryStock = {
			...stock,
			version: stock.version + 1,
			quantity: stock.quantity - line.quantity,
			updatedAt: nowIso,
		};
		await ports.inventoryStock.put(stockId, next);
	}
}

async function markPaymentAttemptSucceeded(
	ports: FinalizePaymentPorts,
	orderId: string,
	providerId: string,
	nowIso: string,
): Promise<void> {
	const res = await ports.paymentAttempts.query({
		where: { orderId, status: "pending" },
		limit: 20,
	});
	const match =
		res.items.find((row) => row.data.providerId === providerId) ?? res.items[0];
	if (!match) return;

	const next: StoredPaymentAttempt = {
		...match.data,
		status: "succeeded",
		updatedAt: nowIso,
	};
	await ports.paymentAttempts.put(match.id, next);
}

/**
 * Single authoritative finalize entry for gateway webhooks (Stripe first).
 */
export async function finalizePaymentFromWebhook(
	ports: FinalizePaymentPorts,
	input: FinalizeWebhookInput,
): Promise<FinalizeWebhookResult> {
	const nowIso = input.nowIso ?? new Date().toISOString();
	const receiptId = webhookReceiptDocId(input.providerId, input.externalEventId);

	const order = await ports.orders.get(input.orderId);
	if (!order) {
		return {
			kind: "api_error",
			error: { code: "ORDER_NOT_FOUND", message: "Order not found" },
		};
	}

	const existingReceipt = await ports.webhookReceipts.get(receiptId);
	const decision = decidePaymentFinalize({
		orderStatus: order.paymentPhase,
		receipt: receiptToView(existingReceipt),
		correlationId: input.correlationId,
	});

	if (decision.action === "noop") {
		ports.log?.info("commerce.finalize.noop", {
			orderId: input.orderId,
			externalEventId: input.externalEventId,
			reason: decision.reason,
		});
		return noopToResult(decision, input.orderId);
	}

	const tokenErr = verifyFinalizeToken(order, input.finalizeToken);
	if (tokenErr) {
		ports.log?.warn("commerce.finalize.token_rejected", { orderId: input.orderId });
		return tokenErr;
	}

	const pendingReceipt: StoredWebhookReceipt = {
		providerId: input.providerId,
		externalEventId: input.externalEventId,
		orderId: input.orderId,
		status: "pending",
		correlationId: input.correlationId,
		createdAt: existingReceipt?.createdAt ?? nowIso,
		updatedAt: nowIso,
	};
	await ports.webhookReceipts.put(receiptId, pendingReceipt);

	const freshOrder = await ports.orders.get(input.orderId);
	if (!freshOrder) {
		await ports.webhookReceipts.put(receiptId, {
			...pendingReceipt,
			status: "error",
			updatedAt: nowIso,
		});
		return {
			kind: "api_error",
			error: { code: "ORDER_NOT_FOUND", message: "Order not found" },
		};
	}

	if (freshOrder.paymentPhase !== "payment_pending" && freshOrder.paymentPhase !== "authorized") {
		await ports.webhookReceipts.put(receiptId, {
			...pendingReceipt,
			status: "error",
			updatedAt: nowIso,
		});
		return {
			kind: "api_error",
			error: {
				code: "ORDER_STATE_CONFLICT",
				message: "Order is not in a finalizable payment state",
				details: { paymentPhase: freshOrder.paymentPhase },
			},
		};
	}

	try {
		await applyInventoryForOrder(ports, freshOrder, input.orderId, nowIso);
	} catch (err) {
		if (err instanceof InventoryFinalizeError) {
			await ports.orders.put(input.orderId, {
				...freshOrder,
				paymentPhase: "payment_conflict",
				updatedAt: nowIso,
			});
			await ports.webhookReceipts.put(receiptId, {
				...pendingReceipt,
				status: "error",
				updatedAt: nowIso,
			});
			const apiCode: CommerceErrorCode =
				err.code === "PRODUCT_UNAVAILABLE" || err.code === "INSUFFICIENT_STOCK"
					? "PAYMENT_CONFLICT"
					: err.code;
			ports.log?.warn("commerce.finalize.inventory_failed", {
				orderId: input.orderId,
				code: apiCode,
				details: err.details,
			});
			return {
				kind: "api_error",
				error: {
					code: apiCode,
					message: err.message,
					details: err.details,
				},
			};
		}
		throw err;
	}

	const paidOrder: StoredOrder = {
		...freshOrder,
		paymentPhase: "paid",
		updatedAt: nowIso,
	};
	await ports.orders.put(input.orderId, paidOrder);

	await ports.webhookReceipts.put(receiptId, {
		...pendingReceipt,
		status: "processed",
		updatedAt: nowIso,
	});

	await markPaymentAttemptSucceeded(ports, input.orderId, input.providerId, nowIso);

	ports.log?.info("commerce.finalize.completed", {
		orderId: input.orderId,
		externalEventId: input.externalEventId,
		correlationId: input.correlationId,
	});

	return { kind: "completed", orderId: input.orderId };
}

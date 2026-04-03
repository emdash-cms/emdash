/**
 * Storage-backed payment finalization (webhook path).
 *
 * Ordering follows architecture §20.5: claim a `webhookReceipts` row (`pending`) →
 * preflight inventory + stock/ledger mutation + order status update.
 *
 * `decidePaymentFinalize` interprets the read model only; this module performs writes.
 *
 * **Concurrency:** Plugin storage has no multi-document transactions and `put` upserts on id
 * only. Two concurrent deliveries of the *same* gateway event can still double-apply
 * inventory until the platform exposes insert-if-not-exists or conditional writes. Receipt
 * + `finalizeTokenHash` reduce *cross-order* abuse; duplicate concurrent same-event remains
 * a documented residual risk.
 */

import type { CommerceApiErrorInput } from "../kernel/api-errors.js";
import type { CommerceErrorCode } from "../kernel/errors.js";
import { decidePaymentFinalize, type WebhookReceiptView } from "../kernel/finalize-decision.js";
import { equalSha256HexDigestAsync, sha256HexAsync } from "../lib/crypto-adapter.js";
import { mergeLineItemsBySku } from "../lib/merge-line-items.js";
import type {
	StoredInventoryLedgerEntry,
	StoredInventoryStock,
	StoredOrder,
	StoredPaymentAttempt,
	StoredWebhookReceipt,
	OrderLineItem,
} from "../types.js";

type FinalizeQueryPage<T> = {
	items: Array<{ id: string; data: T }>;
	hasMore: boolean;
	cursor?: string;
};

type FinalizeQueryOptions<T> = {
	where?: Record<string, unknown>;
	limit?: number;
	orderBy?: Partial<Record<keyof T, "asc" | "desc">>;
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

export type QueryableCollection<T> = FinalizeCollection<T> & {
	query(options?: FinalizeQueryOptions<T>): Promise<FinalizeQueryPage<T>>;
};

export type FinalizePaymentAttemptCollection = FinalizeCollection<StoredPaymentAttempt> & {
	query(
		options?: FinalizeQueryOptions<StoredPaymentAttempt>,
	): Promise<FinalizeQueryPage<StoredPaymentAttempt>>;
};

export type FinalizePaymentPorts = {
	orders: FinalizeCollection<StoredOrder>;
	webhookReceipts: FinalizeCollection<StoredWebhookReceipt>;
	paymentAttempts: FinalizePaymentAttemptCollection;
	inventoryLedger: QueryableCollection<StoredInventoryLedgerEntry>;
	inventoryStock: QueryableCollection<StoredInventoryStock>;
	log?: FinalizeLogPort;
};

export type FinalizeWebhookInput = {
	orderId: string;
	providerId: string;
	externalEventId: string;
	correlationId: string;
	/** Required for all orders. */
	finalizeToken: string;
	/** Inject clock in tests. */
	nowIso?: string;
};

export type FinalizeWebhookResult =
	| { kind: "completed"; orderId: string }
	| { kind: "replay"; reason: string }
	| { kind: "api_error"; error: CommerceApiErrorInput };

type FinalizeFlowDecision =
	| { kind: "noop"; result: FinalizeWebhookResult; reason: string }
	| { kind: "invalid_token"; result: FinalizeWebhookResult }
	| { kind: "proceed"; existingReceipt: StoredWebhookReceipt | null };

type FinalizeLogContext = {
	orderId: string;
	providerId: string;
	externalEventId: string;
	correlationId: string;
};

function buildFinalizeLogContext(input: FinalizeWebhookInput): FinalizeLogContext {
	return {
		orderId: input.orderId,
		providerId: input.providerId,
		externalEventId: input.externalEventId,
		correlationId: input.correlationId,
	};
}

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
	return `wr:${encodeURIComponent(providerId)}:${encodeURIComponent(externalEventId)}`;
}

export function inventoryStockDocId(productId: string, variantId: string): string {
	return `stock:${encodeURIComponent(productId)}:${encodeURIComponent(variantId)}`;
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

async function buildFinalizationDecision(
	order: StoredOrder,
	existingReceipt: StoredWebhookReceipt | null,
	correlationId: string,
	orderId: string,
	inputFinalizeToken: string | undefined,
): Promise<FinalizeFlowDecision> {
	const decision = decidePaymentFinalize({
		orderStatus: order.paymentPhase,
		receipt: receiptToView(existingReceipt),
		correlationId,
	});
	if (decision.action === "noop") {
		return { kind: "noop", result: noopToResult(decision, orderId), reason: decision.reason };
	}
	const tokenErr = await verifyFinalizeToken(order, inputFinalizeToken);
	if (tokenErr) {
		return { kind: "invalid_token", result: tokenErr };
	}
	return { kind: "proceed", existingReceipt };
}

/**
 * A receipt in `pending` status means finalization has started but may not be
 * complete. Specifically:
 *   - inventory may or may not have been applied
 *   - order phase may or may not have been set to `paid`
 *   - payment attempt may or may not have been marked `succeeded`
 *
 * `pending` is the "retry me" signal — not a terminal state. The next call to
 * `finalizePaymentFromWebhook` for the same event will resume from wherever the
 * previous attempt stopped.
 *
 * Terminal receipt states:
 *   - `processed` — all side effects completed successfully
 *   - `error`     — a non-retryable failure was recorded; do not auto-replay
 *   - `duplicate` — event is a known redundant delivery; treat as replay
 */
function createPendingReceipt(
	input: FinalizeWebhookInput,
	existingReceipt: StoredWebhookReceipt | null,
	nowIso: string,
): StoredWebhookReceipt {
	return {
		providerId: input.providerId,
		externalEventId: input.externalEventId,
		orderId: input.orderId,
		status: "pending",
		correlationId: input.correlationId,
		createdAt: existingReceipt?.createdAt ?? nowIso,
		updatedAt: nowIso,
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

async function verifyFinalizeToken(
	order: StoredOrder,
	token: string | undefined,
): Promise<FinalizeWebhookResult | null> {
	const expected = order.finalizeTokenHash;
	if (!token) {
		return {
			kind: "api_error",
			error: {
				code: "ORDER_TOKEN_REQUIRED",
				message: "finalizeToken is required to finalize this order",
			},
		};
	}
	const digest = await sha256HexAsync(token);
	if (!(await equalSha256HexDigestAsync(digest, expected))) {
		return {
			kind: "api_error",
			error: {
				code: "ORDER_TOKEN_INVALID",
				message: "Invalid finalize token for this order",
			},
		};
	}
	return null;
}

type InventoryMutation = {
	line: OrderLineItem;
	stockId: string;
	currentStock: StoredInventoryStock;
	nextStock: StoredInventoryStock;
	ledgerId: string;
};

async function applyInventoryMutation(
	ports: FinalizePaymentPorts,
	orderId: string,
	nowIso: string,
	mutation: InventoryMutation,
): Promise<void> {
	const latest = await ports.inventoryStock.get(mutation.stockId);
	if (!latest) {
		throw new InventoryFinalizeError(
			"PRODUCT_UNAVAILABLE",
			`No inventory record for product ${mutation.line.productId}`,
			{
				productId: mutation.line.productId,
			},
		);
	}
	if (latest.version !== mutation.currentStock.version) {
		throw new InventoryFinalizeError(
			"INVENTORY_CHANGED",
			"Inventory changed between preflight and write",
			{
				productId: mutation.line.productId,
				expectedVersion: mutation.currentStock.version,
				currentVersion: latest.version,
			},
		);
	}
	if (latest.quantity < mutation.line.quantity) {
		throw new InventoryFinalizeError("INSUFFICIENT_STOCK", "Not enough stock at write time", {
			productId: mutation.line.productId,
			requested: mutation.line.quantity,
			available: latest.quantity,
		});
	}
	const entry: StoredInventoryLedgerEntry = {
		productId: mutation.line.productId,
		variantId: mutation.line.variantId ?? "",
		delta: -mutation.line.quantity,
		referenceType: "order",
		referenceId: orderId,
		createdAt: nowIso,
	};
	await ports.inventoryLedger.put(mutation.ledgerId, entry);
	await ports.inventoryStock.put(mutation.stockId, mutation.nextStock);
}

function inventoryLedgerEntryId(orderId: string, productId: string, variantId: string): string {
	return `line:${encodeURIComponent(orderId)}:${encodeURIComponent(productId)}:${encodeURIComponent(
		variantId,
	)}`;
}

function normalizeInventoryMutations(
	orderId: string,
	lineItems: OrderLineItem[],
	stockRows: Map<string, StoredInventoryStock>,
	nowIso: string,
): InventoryMutation[] {
	let merged: OrderLineItem[];
	try {
		merged = mergeLineItemsBySku(lineItems);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new InventoryFinalizeError("ORDER_STATE_CONFLICT", msg, { orderId });
	}

	return merged.map((line) => {
		const stockId = inventoryStockDocId(line.productId, line.variantId ?? "");
		const stock = stockRows.get(stockId);
		if (!stock) {
			throw new InventoryFinalizeError(
				"PRODUCT_UNAVAILABLE",
				`No inventory record for product ${line.productId}`,
				{
					productId: line.productId,
				},
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
			throw new InventoryFinalizeError("INSUFFICIENT_STOCK", "Not enough stock to finalize order", {
				productId: line.productId,
				requested: line.quantity,
				available: stock.quantity,
			});
		}
		const variantId = line.variantId ?? "";
		return {
			line,
			stockId,
			currentStock: stock,
			nextStock: {
				...stock,
				version: stock.version + 1,
				quantity: stock.quantity - line.quantity,
				updatedAt: nowIso,
			},
			ledgerId: inventoryLedgerEntryId(orderId, line.productId, variantId),
		};
	});
}

async function readCurrentStockRows(
	inventoryStock: QueryableCollection<StoredInventoryStock>,
	lines: OrderLineItem[],
): Promise<Map<string, StoredInventoryStock>> {
	const out = new Map<string, StoredInventoryStock>();
	for (const line of lines) {
		const stockId = inventoryStockDocId(line.productId, line.variantId ?? "");
		const stock = await inventoryStock.get(stockId);
		if (!stock) {
			throw new InventoryFinalizeError(
				"PRODUCT_UNAVAILABLE",
				`No inventory record for product ${line.productId}`,
				{
					productId: line.productId,
				},
			);
		}
		out.set(stockId, stock);
	}
	return out;
}

function mapInventoryErrorToApiCode(code: CommerceErrorCode): CommerceErrorCode {
	return code === "PRODUCT_UNAVAILABLE" || code === "INSUFFICIENT_STOCK"
		? "PAYMENT_CONFLICT"
		: code;
}

async function applyInventoryMutations(
	ports: FinalizePaymentPorts,
	orderId: string,
	nowIso: string,
	stockRows: Map<string, StoredInventoryStock>,
	orderLines: OrderLineItem[],
): Promise<void> {
	const existing = await ports.inventoryLedger.query({
		where: { referenceType: "order", referenceId: orderId },
		limit: 1000,
	});
	const seen = new Set(existing.items.map((row) => row.id));

	let merged: OrderLineItem[];
	try {
		merged = mergeLineItemsBySku(orderLines);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new InventoryFinalizeError("ORDER_STATE_CONFLICT", msg, { orderId });
	}

	/**
	 * Reconcile pass: for lines where the ledger row was written but the stock
	 * write did not complete (crash between `inventoryLedger.put` and
	 * `inventoryStock.put` in `applyInventoryMutation`).
	 *
	 * `stock.version === line.inventoryVersion` means the stock was never updated
	 * despite the ledger entry existing — finish just the stock write.
	 * `stock.version > inventoryVersion` means the stock was already updated;
	 * nothing to do for that line.
	 */
	for (const line of merged) {
		const variantId = line.variantId ?? "";
		const stockId = inventoryStockDocId(line.productId, variantId);
		const ledgerId = inventoryLedgerEntryId(orderId, line.productId, variantId);
		if (!seen.has(ledgerId)) continue;
		const stock = stockRows.get(stockId);
		if (!stock) {
			throw new InventoryFinalizeError(
				"PRODUCT_UNAVAILABLE",
				`No inventory record for product ${line.productId}`,
				{ productId: line.productId },
			);
		}
		if (stock.version === line.inventoryVersion) {
			await ports.inventoryStock.put(stockId, {
				...stock,
				version: stock.version + 1,
				quantity: stock.quantity - line.quantity,
				updatedAt: nowIso,
			});
		}
	}

	// Apply pass: lines that have no ledger entry yet.
	const linesNeedingWork: OrderLineItem[] = [];
	for (const line of merged) {
		const variantId = line.variantId ?? "";
		const ledgerId = inventoryLedgerEntryId(orderId, line.productId, variantId);
		if (seen.has(ledgerId)) continue;
		linesNeedingWork.push(line);
	}

	const planned = normalizeInventoryMutations(orderId, linesNeedingWork, stockRows, nowIso);

	for (const mutation of planned) {
		await applyInventoryMutation(ports, orderId, nowIso, mutation);
		seen.add(mutation.ledgerId);
	}
}

async function applyInventoryForOrder(
	ports: FinalizePaymentPorts,
	order: StoredOrder,
	orderId: string,
	nowIso: string,
): Promise<void> {
	const stockRows = await readCurrentStockRows(ports.inventoryStock, order.lineItems);
	await applyInventoryMutations(ports, orderId, nowIso, stockRows, order.lineItems);
}

async function markPaymentAttemptSucceeded(
	ports: FinalizePaymentPorts,
	orderId: string,
	providerId: string,
	nowIso: string,
): Promise<void> {
	const res = await ports.paymentAttempts.query({
		where: { orderId, providerId, status: "pending" },
		orderBy: { createdAt: "asc" },
		limit: 1,
	});
	const match = res.items[0];
	if (!match) return;

	const next: StoredPaymentAttempt = {
		...match.data,
		status: "succeeded",
		updatedAt: nowIso,
	};
	await ports.paymentAttempts.put(match.id, next);
}

/**
 * Finalization state transitions — what each combination means for retry:
 *
 * | Receipt     | Order phase       | Interpretation                        |
 * |-------------|-------------------|---------------------------------------|
 * | (none)      | payment_pending   | Nothing written; safe to start fresh  |
 * | pending     | payment_pending   | Partial progress; resume from here    |
 * | pending     | paid              | Last write (receipt→processed) failed |
 * | processed   | paid              | Replay; all side effects complete     |
 * | error       | any               | Terminal; do not auto-retry           |
 * | duplicate   | any               | Replay; redundant delivery            |
 *
 * Cross-worker concurrency caveat:
 * two processes can still both read a missing receipt and both execute side effects
 * in parallel because storage does not expose a true claim primitive today.
 *
 * A `pending` receipt means the current node claimed this event and something
 * failed partway through. This function handles all partial-success sub-cases:
 *   - inventory ledger written, stock write incomplete  → reconcile pass
 *   - inventory done, order.put failed                 → skip inventory, retry order
 *   - order paid, attempt update failed                → skip both, retry attempt
 *   - everything done except receipt→processed         → skip all writes, mark processed
 */
/**
 * Single authoritative finalize entry for gateway webhooks (Stripe first).
 */
export async function finalizePaymentFromWebhook(
	ports: FinalizePaymentPorts,
	input: FinalizeWebhookInput,
): Promise<FinalizeWebhookResult> {
	const nowIso = input.nowIso ?? new Date().toISOString();
	const logContext = buildFinalizeLogContext(input);
	const receiptId = webhookReceiptDocId(input.providerId, input.externalEventId);

	const order = await ports.orders.get(input.orderId);
	if (!order) {
		ports.log?.warn("commerce.finalize.order_not_found", {
			...logContext,
			stage: "initial_lookup",
		});
		return {
			kind: "api_error",
			error: { code: "ORDER_NOT_FOUND", message: "Order not found" },
		};
	}

	const existingReceipt = await ports.webhookReceipts.get(receiptId);
	const decision = await buildFinalizationDecision(
		order,
		existingReceipt,
		input.correlationId,
		input.orderId,
		input.finalizeToken,
	);
	switch (decision.kind) {
		case "noop":
			ports.log?.info("commerce.finalize.noop", {
				...logContext,
				reason: decision.reason,
			});
			return decision.result;
		case "invalid_token":
			ports.log?.warn("commerce.finalize.token_rejected", logContext);
			return decision.result;
		case "proceed":
			break;
		default:
			break;
	}

	const pendingReceipt = createPendingReceipt(input, decision.existingReceipt, nowIso);
	ports.log?.info("commerce.finalize.receipt_pending", {
		...logContext,
		stage: "pending_receipt_written",
		priorReceiptStatus: decision.existingReceipt?.status,
	});
	await ports.webhookReceipts.put(receiptId, pendingReceipt);

	const freshOrder = await ports.orders.get(input.orderId);
	if (!freshOrder) {
		ports.log?.warn("commerce.finalize.order_not_found", {
			...logContext,
			stage: "post_pending_lookup",
		});

		/**
		 * Operational meaning of `error` today:
		 * order row disappeared while finalization was running.
		 * Treat as terminal and escalate rather than auto-retrying indefinitely.
		 */
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

	const shouldApplyInventory = freshOrder.paymentPhase !== "paid";
	if (shouldApplyInventory) {
		if (freshOrder.paymentPhase !== "payment_pending" && freshOrder.paymentPhase !== "authorized") {
			ports.log?.warn("commerce.finalize.order_not_finalizable", {
				...logContext,
				paymentPhase: freshOrder.paymentPhase,
			});
			/**
			 * Order moved to a non-finalizable phase between the initial read and
			 * the pending-receipt write (e.g. concurrent finalize completed first).
			 * Mark the receipt `error` so it does not stay stuck in `pending`
			 * and operators get a clear terminal signal.
			 */
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
			ports.log?.info("commerce.finalize.inventory_reconcile", {
				...logContext,
				paymentPhase: freshOrder.paymentPhase,
			});
			await applyInventoryForOrder(ports, freshOrder, input.orderId, nowIso);
			ports.log?.info("commerce.finalize.inventory_applied", {
				...logContext,
				orderId: input.orderId,
			});
		} catch (err) {
			if (err instanceof InventoryFinalizeError) {
				const apiCode = mapInventoryErrorToApiCode(err.code);
				ports.log?.warn("commerce.finalize.inventory_failed", {
					...logContext,
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
	}

	if (freshOrder.paymentPhase !== "paid") {
		ports.log?.info("commerce.finalize.order_settlement_attempt", {
			...logContext,
			orderId: input.orderId,
			paymentPhase: freshOrder.paymentPhase,
		});
		const paidOrder: StoredOrder = {
			...freshOrder,
			paymentPhase: "paid",
			updatedAt: nowIso,
		};
		try {
			await ports.orders.put(input.orderId, paidOrder);
		} catch (err) {
			ports.log?.warn("commerce.finalize.order_update_failed", {
				...logContext,
				details: err instanceof Error ? err.message : String(err),
			});
			return {
				kind: "api_error",
				error: {
					code: "ORDER_STATE_CONFLICT",
					message: "Failed to persist order finalization",
					details: { orderId: input.orderId },
				},
			};
		}
	}

	try {
		ports.log?.info("commerce.finalize.payment_attempt_update_attempt", {
			...logContext,
			orderId: input.orderId,
			providerId: input.providerId,
		});
		await markPaymentAttemptSucceeded(ports, input.orderId, input.providerId, nowIso);
	} catch (err) {
		ports.log?.warn("commerce.finalize.attempt_update_failed", {
			...logContext,
			details: err instanceof Error ? err.message : String(err),
		});
		return {
			kind: "api_error",
			error: {
				code: "ORDER_STATE_CONFLICT",
				message: "Failed to persist payment attempt finalization",
				details: { orderId: input.orderId },
			},
		};
	}

	/**
	 * Intentionally let this fail loudly.
	 * All prior side effects are persisted; with `pendingReceipt` + resume logic,
	 * retry is safe and expected to complete this final write.
	 */
	try {
		ports.log?.info("commerce.finalize.receipt_processed", {
			...logContext,
			stage: "finalize",
		});
		await ports.webhookReceipts.put(receiptId, {
			...pendingReceipt,
			status: "processed",
			updatedAt: nowIso,
		});
	} catch (err) {
		ports.log?.warn("commerce.finalize.receipt_processed_write_failed", {
			...logContext,
			details: err instanceof Error ? err.message : String(err),
		});
		throw err;
	}

	ports.log?.info("commerce.finalize.completed", {
		...logContext,
		stage: "completed",
	});

	return { kind: "completed", orderId: input.orderId };
}

/**
 * Operational recovery helper: answers the four key questions for diagnosing
 * a partially-finalized order without reading every collection manually.
 *
 * Intended for use in runbooks, admin tooling, and integration test assertions.
 * Does not modify any state.
 */
export type FinalizationStatus = {
	/** Raw webhook-receipt status for quick runbook triage. */
	receiptStatus: "missing" | "pending" | "processed" | "error" | "duplicate";
	/** At least one inventory ledger row exists for this order. */
	isInventoryApplied: boolean;
	/** Order paymentPhase is "paid". */
	isOrderPaid: boolean;
	/** At least one payment attempt for this order+provider is "succeeded". */
	isPaymentAttemptSucceeded: boolean;
	/** Webhook receipt for this event is "processed". */
	isReceiptProcessed: boolean;
	/**
	 * Human-readable resume state for operations that consume this helper as a
	 * status surface (MCP, support tooling, runbooks).
	 * `event_unknown` means the order/attempt/ledger already indicate completion
	 * but no receipt row exists for this external event id.
	 */
	resumeState:
		| "not_started"
		| "replay_processed"
		| "replay_duplicate"
		| "error"
		| "event_unknown"
		| "pending_inventory"
		| "pending_order"
		| "pending_attempt"
		| "pending_receipt";
};

function deriveFinalizationResumeState(input: {
	receiptStatus: FinalizationStatus["receiptStatus"];
	isInventoryApplied: boolean;
	isOrderPaid: boolean;
	isPaymentAttemptSucceeded: boolean;
	isReceiptProcessed: boolean;
}): FinalizationStatus["resumeState"] {
	if (input.receiptStatus === "processed" || input.isReceiptProcessed) return "replay_processed";
	if (input.receiptStatus === "duplicate") return "replay_duplicate";
	if (input.receiptStatus === "error") return "error";
	if (input.receiptStatus === "missing") {
		if (input.isInventoryApplied && input.isOrderPaid && input.isPaymentAttemptSucceeded) {
			return "event_unknown";
		}
		return "not_started";
	}
	if (!input.isInventoryApplied) return "pending_inventory";
	if (!input.isOrderPaid) return "pending_order";
	if (!input.isPaymentAttemptSucceeded) return "pending_attempt";
	return "pending_receipt";
}

export async function queryFinalizationStatus(
	ports: FinalizePaymentPorts,
	orderId: string,
	providerId: string,
	externalEventId: string,
): Promise<FinalizationStatus> {
	const receiptId = webhookReceiptDocId(providerId, externalEventId);
	const [order, receipt, ledgerPage, attemptPage] = await Promise.all([
		ports.orders.get(orderId),
		ports.webhookReceipts.get(receiptId),
		ports.inventoryLedger.query({
			where: { referenceType: "order", referenceId: orderId },
			limit: 1,
		}),
		ports.paymentAttempts.query({ where: { orderId, providerId, status: "succeeded" }, limit: 1 }),
	]);
	const status: FinalizationStatus = {
		receiptStatus: receipt?.status ?? "missing",
		isInventoryApplied: ledgerPage.items.length > 0,
		isOrderPaid: order?.paymentPhase === "paid",
		isPaymentAttemptSucceeded: attemptPage.items.length > 0,
		isReceiptProcessed: receipt?.status === "processed",
		resumeState: "not_started",
	};
	status.resumeState = deriveFinalizationResumeState(status);
	return status;
}

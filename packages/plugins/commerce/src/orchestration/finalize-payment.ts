/**
 * Storage-backed payment finalization (webhook path).
 *
 * Ordering follows architecture §20.5: claim a `webhookReceipts` row (`pending`) →
 * preflight inventory + stock/ledger mutation + order status update.
 *
 * `decidePaymentFinalize` interprets the read model only; this module performs writes.
 *
 * **Concurrency:** `webhookReceipts.putIfAbsent` (when available) plus pending/fresh claim
 * rules serialize same-event overlap; terminal receipt rows short-circuit losers without
 * overwriting `processed`/`duplicate`/`error` state.
 */

import type { CommerceApiErrorInput } from "../kernel/api-errors.js";
import { decidePaymentFinalize, type WebhookReceiptView } from "../kernel/finalize-decision.js";
import { equalSha256HexDigestAsync, sha256HexAsync } from "../lib/crypto-adapter.js";
import type {
	StoredInventoryLedgerEntry,
	StoredInventoryStock,
	StoredOrder,
	StoredPaymentAttempt,
	StoredWebhookReceipt,
	WebhookReceiptErrorCode,
} from "../types.js";
import type { CommerceErrorCode } from "../kernel/errors.js";
import {
	InventoryFinalizeError,
	applyInventoryForOrder,
	inventoryStockDocId,
	isTerminalInventoryFailure,
	mapInventoryErrorToApiCode,
} from "./finalize-payment-inventory.js";
import {
	deriveFinalizationResumeState,
	type FinalizationStatus,
} from "./finalize-payment-status.js";

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
	putIfAbsent?(id: string, data: T): Promise<boolean>;
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

const WEBHOOK_RECEIPT_CLAIM_STALE_WINDOW_MS = 30_000;
const FINALIZE_INVARIANT_CHECKS = process.env.COMMERCE_ENABLE_FINALIZE_INVARIANT_CHECKS === "1";

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

/** Stable document id for a webhook receipt (primary-key dedupe per event). */
export function webhookReceiptDocId(providerId: string, externalEventId: string): string {
	return `wr:${encodeURIComponent(providerId)}:${encodeURIComponent(externalEventId)}`;
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

function isReceiptClaimFresh(
	receipt: StoredWebhookReceipt,
	nowIso: string,
	staleWindowMs: number,
): boolean {
	const updatedMs = Date.parse(receipt.updatedAt);
	const nowMs = Date.parse(nowIso);
	// Unparseable timestamps → stale: allow another worker to take over the claim.
	if (!Number.isFinite(updatedMs) || !Number.isFinite(nowMs)) return false;
	return nowMs - updatedMs <= staleWindowMs;
}

async function claimWebhookReceipt({
	ports,
	receiptId,
	receipt,
	nowIso,
}: {
	ports: FinalizePaymentPorts;
	receiptId: string;
	receipt: StoredWebhookReceipt;
	nowIso: string;
}): Promise<{ kind: "acquired" } | { kind: "replay"; result: FinalizeWebhookResult }> {
	if (!ports.webhookReceipts.putIfAbsent) {
		return { kind: "acquired" };
	}

	const claimedNow = await ports.webhookReceipts.putIfAbsent(receiptId, receipt);
	if (claimedNow) {
		return { kind: "acquired" };
	}

	const existing = await ports.webhookReceipts.get(receiptId);
	if (!existing) {
		const replayInsert = await ports.webhookReceipts.putIfAbsent(receiptId, receipt);
		if (replayInsert) return { kind: "acquired" };
		return {
			kind: "replay",
			result: {
				kind: "replay",
				reason: "webhook_receipt_claim_retry_failed",
			},
		};
	}

	if (existing.status === "processed") {
		return { kind: "replay", result: { kind: "replay", reason: "webhook_receipt_processed" } };
	}
	if (existing.status === "duplicate") {
		return { kind: "replay", result: { kind: "replay", reason: "webhook_receipt_duplicate" } };
	}
	if (existing.status === "error") {
		return { kind: "replay", result: { kind: "replay", reason: "webhook_error" } };
	}

	// `pending`: stale or unparseable updatedAt → allow this worker to take over; fresh → same-event overlap.
	if (!isReceiptClaimFresh(existing, nowIso, WEBHOOK_RECEIPT_CLAIM_STALE_WINDOW_MS)) {
		return { kind: "acquired" };
	}

	return {
		kind: "replay",
		result: { kind: "replay", reason: "webhook_receipt_in_flight" },
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

async function persistReceiptStatus(
	ports: FinalizePaymentPorts,
	receiptId: string,
	receipt: StoredWebhookReceipt,
	status: StoredWebhookReceipt["status"],
	nowIso: string,
	errorCode?: StoredWebhookReceipt["errorCode"],
	errorDetails?: Record<string, unknown>,
): Promise<void> {
	await ports.webhookReceipts.put(receiptId, {
		...receipt,
		status,
		errorCode: status === "error" ? errorCode : undefined,
		errorDetails: status === "error" ? errorDetails ?? receipt.errorDetails : undefined,
		updatedAt: nowIso,
	});
}

function mapInventoryFinalizeErrorToReceiptCode(code: CommerceErrorCode): WebhookReceiptErrorCode {
	if (code === "PRODUCT_UNAVAILABLE") return "PRODUCT_UNAVAILABLE";
	if (code === "INSUFFICIENT_STOCK") return "INSUFFICIENT_STOCK";
	if (code === "INVENTORY_CHANGED") return "INVENTORY_CHANGED";
	if (code === "ORDER_STATE_CONFLICT") return "ORDER_STATE_CONFLICT";
	return "ORDER_STATE_CONFLICT";
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
 * if a process stalls while processing an event (for longer than the claim window),
 * another worker may start and replay this event. The claim window keeps overlap low,
 * and idempotent writes keep the path safe if this still happens.
 *
 * A `pending` receipt means the current node claimed this event and something
 * failed partway through. This function handles all partial-success sub-cases:
 *   - inventory ledger written, stock write incomplete  → reconcile pass
 *   - inventory done, order.put failed                 → skip inventory, retry order
 *   - order paid, attempt update failed                → skip both, retry attempt
 *   - everything done except receipt→processed         → skip all writes, mark processed
 * When inventory preconditions are permanently invalid (missing stock,
 * insufficient stock, or stale version snapshot), the receipt transitions to
 * `error` so retries do not replay known terminal conflicts.
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

	const stagedReceipt = createPendingReceipt(input, decision.existingReceipt, nowIso);
	const claim = await claimWebhookReceipt({
		ports,
		receiptId,
		receipt: stagedReceipt,
		nowIso,
	});
	if (claim.kind === "replay") {
		ports.log?.info("commerce.finalize.noop", {
			...logContext,
			reason: "webhook_receipt_claim_in_flight",
		});
		return claim.result;
	}

	const pendingReceipt = stagedReceipt;
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
		await persistReceiptStatus(
			ports,
			receiptId,
			pendingReceipt,
			"error",
			nowIso,
			"ORDER_NOT_FOUND",
			{ orderId: input.orderId, correlationId: input.correlationId },
		);
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
			await persistReceiptStatus(
				ports,
				receiptId,
				pendingReceipt,
				"error",
				nowIso,
				"ORDER_STATE_CONFLICT",
				{ paymentPhase: freshOrder.paymentPhase },
			);
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
				if (isTerminalInventoryFailure(err.code)) {
					ports.log?.warn("commerce.finalize.inventory_failed_terminal", {
						...logContext,
						code: apiCode,
						details: err.details,
					});
					await persistReceiptStatus(
						ports,
						receiptId,
						pendingReceipt,
						"error",
						nowIso,
						mapInventoryFinalizeErrorToReceiptCode(err.code),
						{
							...err.details,
							inventoryErrorCode: err.code,
							commerceErrorCode: apiCode,
						},
					);
				} else {
					ports.log?.warn("commerce.finalize.inventory_failed", {
						...logContext,
						code: apiCode,
						details: err.details,
					});
				}
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

	if (FINALIZE_INVARIANT_CHECKS) {
		await validateFinalizationInvariants(ports, input, logContext);
	}

	return { kind: "completed", orderId: input.orderId };
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
		receiptErrorCode: receipt?.errorCode,
		resumeState: "not_started",
	};
	status.resumeState = deriveFinalizationResumeState(status);
	return status;
}

async function validateFinalizationInvariants(
	ports: FinalizePaymentPorts,
	input: FinalizeWebhookInput,
	logContext: FinalizeLogContext,
): Promise<void> {
	const status = await queryFinalizationStatus(
		ports,
		input.orderId,
		input.providerId,
		input.externalEventId,
	);
	if (!status.isOrderPaid) {
		ports.log?.warn("commerce.finalize.invariant_failed", {
			...logContext,
			reason: "order_not_paid_after_complete",
			resumeState: status.resumeState,
		});
	}
	if (!status.isPaymentAttemptSucceeded) {
		ports.log?.warn("commerce.finalize.invariant_failed", {
			...logContext,
			reason: "payment_attempt_not_succeeded_after_complete",
			resumeState: status.resumeState,
		});
	}
	if (!status.isInventoryApplied) {
		ports.log?.warn("commerce.finalize.invariant_failed", {
			...logContext,
			reason: "inventory_not_applied_after_complete",
			resumeState: status.resumeState,
		});
	}
}

export type { FinalizationStatus } from "./finalize-payment-status.js";
export { deriveFinalizationResumeState } from "./finalize-payment-status.js";
export { inventoryStockDocId } from "./finalize-payment-inventory.js";

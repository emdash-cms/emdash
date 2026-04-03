/**
 * Pure decision step: **may this finalize attempt proceed** given the current
 * read model (order phase + webhook receipt row view).
 *
 * This is **not** the full payment-reconciliation or HTTP error surface.
 * Signature verification, provider errors, inventory conflicts, and ledger
 * writes live in orchestration and storage; they may introduce additional
 * codes and outcomes beyond `FinalizeNoopCode`.
 *
 * `FinalizeNoopCode` stays intentionally narrow: only outcomes this helper
 * can emit today. Do not overload `ORDER_STATE_CONFLICT` for unrelated
 * domains here—extend orchestration or add dedicated decision helpers when
 * those paths exist.
 *
 * Storage must insert `webhookReceipts` with a unique `externalEventId`;
 * this module only interprets the read model passed in.
 */

export type OrderPaymentPhase =
	| "draft"
	| "payment_pending"
	| "authorized"
	| "paid"
	| "payment_conflict"
	| "processing"
	| "fulfilled"
	| "refund_pending"
	| "refunded"
	| "canceled";

/**
 * Minimal receipt state for idempotent finalize. **Storage-facing semantics to
 * pin before persistence ships:**
 *
 * - **processed** — this `externalEventId` was fully handled; side effects
 *   (e.g. order transition) completed successfully. Terminal.
 * - **duplicate** — derived duplicate classification from storage/orchestration:
 *   a delivery must not execute finalize again because it is redundant relative
 *   to an already-known receipt. Retry is not useful here.
 * - **pending** — receipt row exists but processing is incomplete. Retry may be
 *   valid once that row resolves.
 * - **error** — terminal failure recorded for this receipt row. Today this is used
 *   when the order record disappears while finalization is running; orchestration
 *   blocks automatic replay unless a future explicit recovery path is added.
 */
export type WebhookReceiptView =
	| { exists: false }
	| { exists: true; status: "processed" | "duplicate" | "error" | "pending" };

/** Internal ids; at HTTP boundary use `commerceErrorCodeToWire()` from `./errors`. */
export type FinalizeNoopCode = "WEBHOOK_REPLAY_DETECTED" | "ORDER_STATE_CONFLICT";
export type FinalizeNoopReason =
	| "order_already_paid"
	| "webhook_receipt_processed"
	| "webhook_receipt_duplicate"
	| "webhook_error"
	| "webhook_pending"
	| "order_not_finalizable";

export type FinalizeDecision =
	| { action: "proceed"; correlationId: string }
	| {
			action: "noop";
			reason: FinalizeNoopReason;
			httpStatus: number;
			code: FinalizeNoopCode;
	  };

const FINALIZABLE: ReadonlySet<OrderPaymentPhase> = new Set(["payment_pending", "authorized"]);

export function decidePaymentFinalize(input: {
	orderStatus: OrderPaymentPhase;
	receipt: WebhookReceiptView;
	correlationId: string;
}): FinalizeDecision {
	const { orderStatus, receipt, correlationId } = input;

	if (receipt.exists) {
		if (receipt.status === "pending") {
			if (
				orderStatus === "payment_pending" ||
				orderStatus === "authorized" ||
				orderStatus === "paid"
			) {
				return { action: "proceed", correlationId };
			}

			return {
				action: "noop",
				reason: "webhook_pending",
				httpStatus: 409,
				code: "ORDER_STATE_CONFLICT",
			};
		}

		if (receipt.status === "processed") {
			return {
				action: "noop",
				reason: "webhook_receipt_processed",
				httpStatus: 200,
				code: "WEBHOOK_REPLAY_DETECTED",
			};
		}

		if (receipt.status === "duplicate") {
			return {
				action: "noop",
				reason: "webhook_receipt_duplicate",
				httpStatus: 200,
				code: "WEBHOOK_REPLAY_DETECTED",
			};
		}

		return {
			action: "noop",
			reason: "webhook_error",
			httpStatus: 409,
			code: "ORDER_STATE_CONFLICT",
		};
	}

	if (orderStatus === "paid") {
		return {
			action: "noop",
			reason: "order_already_paid",
			httpStatus: 200,
			code: "WEBHOOK_REPLAY_DETECTED",
		};
	}

	if (!FINALIZABLE.has(orderStatus)) {
		return {
			action: "noop",
			reason: "order_not_finalizable",
			httpStatus: 409,
			code: "ORDER_STATE_CONFLICT",
		};
	}

	return { action: "proceed", correlationId };
}

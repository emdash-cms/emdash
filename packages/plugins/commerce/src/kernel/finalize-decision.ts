/**
 * Pure decision step for payment finalization idempotency.
 * Storage is responsible for inserting `webhookReceipts` with a unique
 * `externalEventId`; this module only interprets the read model.
 */

export type OrderPaymentPhase =
	| "draft"
	| "payment_pending"
	| "authorized"
	| "paid"
	| "payment_conflict"
	| "canceled";

export type WebhookReceiptView =
	| { exists: false }
	| { exists: true; status: "processed" | "duplicate" | "error" | "pending" };

export type FinalizeNoopCode = "WEBHOOK_REPLAY_DETECTED" | "ORDER_STATE_CONFLICT";

export type FinalizeDecision =
	| { action: "proceed"; correlationId: string }
	| {
			action: "noop";
			reason: "order_already_paid" | "webhook_already_processed" | "order_not_finalizable";
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

	if (orderStatus === "paid") {
		return {
			action: "noop",
			reason: "order_already_paid",
			httpStatus: 200,
			code: "WEBHOOK_REPLAY_DETECTED",
		};
	}

	if (receipt.exists && receipt.status === "processed") {
		return {
			action: "noop",
			reason: "webhook_already_processed",
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

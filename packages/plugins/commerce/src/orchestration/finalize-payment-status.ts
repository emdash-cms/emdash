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

export function deriveFinalizationResumeState(input: {
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

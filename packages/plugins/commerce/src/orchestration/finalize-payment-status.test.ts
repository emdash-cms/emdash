import { describe, expect, it } from "vitest";

import { deriveFinalizationResumeState } from "./finalize-payment-status.js";

describe("deriveFinalizationResumeState", () => {
	it("returns replay_processed when receipt is already processed", () => {
		expect(
			deriveFinalizationResumeState({
				receiptStatus: "processed",
				isInventoryApplied: false,
				isOrderPaid: false,
				isPaymentAttemptSucceeded: false,
				isReceiptProcessed: false,
			}),
		).toBe("replay_processed");
	});

	it("returns replay_processed when receipt row is marked processed through receipt flag", () => {
		expect(
			deriveFinalizationResumeState({
				receiptStatus: "missing",
				isInventoryApplied: false,
				isOrderPaid: false,
				isPaymentAttemptSucceeded: false,
				isReceiptProcessed: true,
			}),
		).toBe("replay_processed");
	});

	it("returns replay_duplicate for duplicate receipts", () => {
		expect(
			deriveFinalizationResumeState({
				receiptStatus: "duplicate",
				isInventoryApplied: false,
				isOrderPaid: false,
				isPaymentAttemptSucceeded: false,
				isReceiptProcessed: false,
			}),
		).toBe("replay_duplicate");
	});

	it("returns error for terminal error receipts", () => {
		expect(
			deriveFinalizationResumeState({
				receiptStatus: "error",
				isInventoryApplied: true,
				isOrderPaid: false,
				isPaymentAttemptSucceeded: false,
				isReceiptProcessed: false,
			}),
		).toBe("error");
	});

	it("returns event_unknown when completed work exists without a receipt row", () => {
		expect(
			deriveFinalizationResumeState({
				receiptStatus: "missing",
				isInventoryApplied: true,
				isOrderPaid: true,
				isPaymentAttemptSucceeded: true,
				isReceiptProcessed: false,
			}),
		).toBe("event_unknown");
	});

	it("returns not_started when finalization has not begun", () => {
		expect(
			deriveFinalizationResumeState({
				receiptStatus: "missing",
				isInventoryApplied: false,
				isOrderPaid: false,
				isPaymentAttemptSucceeded: false,
				isReceiptProcessed: false,
			}),
		).toBe("not_started");
	});

	it("returns pending_inventory when inventory ledger is not yet written", () => {
		expect(
			deriveFinalizationResumeState({
				receiptStatus: "pending",
				isInventoryApplied: false,
				isOrderPaid: true,
				isPaymentAttemptSucceeded: true,
				isReceiptProcessed: false,
			}),
		).toBe("pending_inventory");
	});

	it("returns pending_order when payment phase update has not completed", () => {
		expect(
			deriveFinalizationResumeState({
				receiptStatus: "pending",
				isInventoryApplied: true,
				isOrderPaid: false,
				isPaymentAttemptSucceeded: true,
				isReceiptProcessed: false,
			}),
		).toBe("pending_order");
	});

	it("returns pending_attempt when payment attempt finalization has not completed", () => {
		expect(
			deriveFinalizationResumeState({
				receiptStatus: "pending",
				isInventoryApplied: true,
				isOrderPaid: true,
				isPaymentAttemptSucceeded: false,
				isReceiptProcessed: false,
			}),
		).toBe("pending_attempt");
	});

	it("returns pending_receipt when only receipt write remains", () => {
		expect(
			deriveFinalizationResumeState({
				receiptStatus: "pending",
				isInventoryApplied: true,
				isOrderPaid: true,
				isPaymentAttemptSucceeded: true,
				isReceiptProcessed: false,
			}),
		).toBe("pending_receipt");
	});
});

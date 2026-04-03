import { describe, expect, it } from "vitest";

import { decidePaymentFinalize } from "./finalize-decision.js";

describe("decidePaymentFinalize", () => {
	const cid = "corr-1";

	it("proceeds when order awaits payment and no processed receipt", () => {
		expect(
			decidePaymentFinalize({
				orderStatus: "payment_pending",
				receipt: { exists: false },
				correlationId: cid,
			}),
		).toEqual({ action: "proceed", correlationId: cid });
	});

	it("proceeds when order is authorized and no receipt exists", () => {
		expect(
			decidePaymentFinalize({
				orderStatus: "authorized",
				receipt: { exists: false },
				correlationId: cid,
			}),
		).toEqual({ action: "proceed", correlationId: cid });
	});

	it("noop when order already paid and webhook receipt already processed (replay)", () => {
		const d = decidePaymentFinalize({
			orderStatus: "paid",
			receipt: { exists: true, status: "processed" },
			correlationId: cid,
		});
		expect(d.action).toBe("noop");
		if (d.action === "noop") {
			expect(d.httpStatus).toBe(200);
			expect(d.code).toBe("WEBHOOK_REPLAY_DETECTED");
			expect(d.reason).toBe("webhook_receipt_processed");
		}
	});

	it("noop when webhook was already processed", () => {
		const d = decidePaymentFinalize({
			orderStatus: "payment_pending",
			receipt: { exists: true, status: "processed" },
			correlationId: cid,
		});
		expect(d).toEqual({
			action: "noop",
			reason: "webhook_receipt_processed",
			httpStatus: 200,
			code: "WEBHOOK_REPLAY_DETECTED",
		});
	});

	it("noop when webhook is duplicate", () => {
		const d = decidePaymentFinalize({
			orderStatus: "payment_pending",
			receipt: { exists: true, status: "duplicate" },
			correlationId: cid,
		});
		expect(d).toMatchObject({
			action: "noop",
			reason: "webhook_receipt_duplicate",
			httpStatus: 200,
			code: "WEBHOOK_REPLAY_DETECTED",
		});
	});

	it("resumes finalization when webhook row is pending and order is already paid", () => {
		const d = decidePaymentFinalize({
			orderStatus: "paid",
			receipt: { exists: true, status: "pending" },
			correlationId: cid,
		});
		expect(d).toEqual({ action: "proceed", correlationId: cid });
	});

	it("continues when webhook row is pending and payment is still in progress", () => {
		const d = decidePaymentFinalize({
			orderStatus: "payment_pending",
			receipt: { exists: true, status: "pending" },
			correlationId: cid,
		});
		expect(d).toEqual({ action: "proceed", correlationId: cid });
	});

	it("continues when webhook row is pending while still authorized", () => {
		const d = decidePaymentFinalize({
			orderStatus: "authorized",
			receipt: { exists: true, status: "pending" },
			correlationId: cid,
		});
		expect(d).toEqual({ action: "proceed", correlationId: cid });
	});

	it("conflict when webhook is error", () => {
		const d = decidePaymentFinalize({
			orderStatus: "payment_pending",
			receipt: { exists: true, status: "error" },
			correlationId: cid,
		});
		expect(d).toMatchObject({
			action: "noop",
			reason: "webhook_error",
			httpStatus: 409,
			code: "ORDER_STATE_CONFLICT",
		});
	});

	it("conflict when order is in draft", () => {
		const d = decidePaymentFinalize({
			orderStatus: "draft",
			receipt: { exists: false },
			correlationId: cid,
		});
		expect(d).toMatchObject({
			action: "noop",
			reason: "order_not_finalizable",
			httpStatus: 409,
			code: "ORDER_STATE_CONFLICT",
		});
	});

	it("conflict when order is canceled", () => {
		const d = decidePaymentFinalize({
			orderStatus: "canceled",
			receipt: { exists: false },
			correlationId: cid,
		});
		expect(d).toMatchObject({
			action: "noop",
			reason: "order_not_finalizable",
			httpStatus: 409,
			code: "ORDER_STATE_CONFLICT",
		});
	});
});

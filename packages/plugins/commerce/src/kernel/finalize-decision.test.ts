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

	it("noop when order already paid (gateway retry)", () => {
		const d = decidePaymentFinalize({
			orderStatus: "paid",
			receipt: { exists: true, status: "processed" },
			correlationId: cid,
		});
		expect(d.action).toBe("noop");
		if (d.action === "noop") {
			expect(d.httpStatus).toBe(200);
			expect(d.code).toBe("WEBHOOK_REPLAY_DETECTED");
		}
	});

	it("noop when receipt already processed even if order still pending (should not happen if impl is correct)", () => {
		const d = decidePaymentFinalize({
			orderStatus: "payment_pending",
			receipt: { exists: true, status: "processed" },
			correlationId: cid,
		});
		expect(d.action).toBe("noop");
	});

	it("conflict when order in draft", () => {
		const d = decidePaymentFinalize({
			orderStatus: "draft",
			receipt: { exists: false },
			correlationId: cid,
		});
		expect(d).toMatchObject({ action: "noop", code: "ORDER_STATE_CONFLICT" });
	});
});

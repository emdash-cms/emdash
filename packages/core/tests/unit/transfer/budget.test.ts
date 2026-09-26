import { describe, expect, it } from "vitest";

import { TransferStepBudget } from "../../../src/transfer/ops/budget.js";

describe("TransferStepBudget", () => {
	it("stops starting units once the request's queries approach the ceiling", () => {
		const metrics = { dbCount: 700 };
		const budget = new TransferStepBudget({ metrics });
		expect(budget.canStart()).toBe(true);
		budget.start();
		metrics.dbCount = 760;
		expect(budget.canStart()).toBe(false);
		expect(budget.canStart({ queries: 100 })).toBe(true);
	});

	it("refuses even the first unit when the request is already over budget", () => {
		const budget = new TransferStepBudget({ metrics: { dbCount: 800 } });
		expect(budget.canStart()).toBe(false);
	});

	it("limits bytes per step but always lets a single oversized blob through first", () => {
		const budget = new TransferStepBudget({ metrics: { dbCount: 0 }, bytes: 100 });
		expect(budget.canStart({ bytes: 500 })).toBe(true);
		budget.start(500);
		expect(budget.canStart({ bytes: 1 })).toBe(false);
		expect(budget.canStart({ bytes: 0 })).toBe(true);

		const fresh = new TransferStepBudget({ metrics: { dbCount: 0 }, bytes: 100 });
		fresh.start(60);
		expect(fresh.canStart({ bytes: 40 })).toBe(true);
		expect(fresh.canStart({ bytes: 41 })).toBe(false);
		expect(fresh.remaining().bytes).toBe(40);
	});

	it("only limits bytes outside a request", () => {
		const budget = new TransferStepBudget({ bytes: 10 });
		budget.start(5);
		expect(budget.canStart({ queries: 10_000 })).toBe(true);
		expect(budget.remaining().queries).toBe(Number.POSITIVE_INFINITY);
	});
});

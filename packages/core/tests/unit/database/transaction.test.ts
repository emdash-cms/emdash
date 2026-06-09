import { describe, expect, it, vi } from "vitest";

import { withTransaction } from "../../../src/database/transaction.js";

const D1_ADAPTER_MARKER = Symbol.for("emdash:d1-adapter");

describe("withTransaction", () => {
	it("skips transaction probing for marked D1 adapters", async () => {
		const adapter = { [D1_ADAPTER_MARKER]: true };
		const transactionExecute = vi.fn();
		const db = {
			getExecutor: () => ({ adapter }),
			transaction: () => ({ execute: transactionExecute }),
		};
		const fn = vi.fn(async (trx: unknown) => {
			expect(trx).toBe(db);
			return "ok";
		});

		const result = await withTransaction(db as never, fn);

		expect(result).toBe("ok");
		expect(fn).toHaveBeenCalledTimes(1);
		expect(transactionExecute).not.toHaveBeenCalled();
	});

	it("caches unsupported transaction support per adapter after the first probe", async () => {
		const adapter = {};
		let executeCalls = 0;
		const db = {
			getExecutor: () => ({ adapter }),
			transaction: () => ({
				execute: async () => {
					executeCalls += 1;
					throw new Error("Transactions are not supported yet.");
				},
			}),
		};
		const fn = vi.fn(async () => "ok");

		const first = await withTransaction(db as never, fn);
		const second = await withTransaction(db as never, fn);

		expect(first).toBe("ok");
		expect(second).toBe("ok");
		expect(executeCalls).toBe(1);
		expect(fn).toHaveBeenCalledTimes(2);
	});
});

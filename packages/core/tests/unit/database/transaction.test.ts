import { describe, expect, it, vi } from "vitest";

import { withTransaction } from "../../../src/database/transaction.js";

const TRANSACTIONS_UNSUPPORTED_MARKER = Symbol.for("emdash:transactions-unsupported");

function createDb(options: { adapter?: object; transactionError?: Error } = {}) {
	const adapter = options.adapter ?? {};
	const trx = {};
	const execute = vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => {
		if (options.transactionError) throw options.transactionError;
		return callback(trx);
	});
	const db = {
		getExecutor: () => ({ adapter }),
		transaction: () => ({ execute }),
	};
	return { adapter, db, execute, trx };
}

describe("withTransaction", () => {
	it("skips transaction setup for adapters that declare transactions unsupported", async () => {
		const { db, execute } = createDb({
			adapter: { [TRANSACTIONS_UNSUPPORTED_MARKER]: true },
		});
		const fn = vi.fn(async (received: unknown) => {
			expect(received).toBe(db);
			return "ok";
		});

		await expect(withTransaction(db as never, fn)).resolves.toBe("ok");
		expect(execute).not.toHaveBeenCalled();
	});

	it("caches an unsupported beginTransaction result per adapter", async () => {
		const { db, execute } = createDb({
			transactionError: new Error("Transactions are not supported yet."),
		});
		const fn = vi.fn(async () => "ok");

		await expect(withTransaction(db as never, fn)).resolves.toBe("ok");
		await expect(withTransaction(db as never, fn)).resolves.toBe("ok");

		expect(execute).toHaveBeenCalledTimes(1);
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("does not reuse an unsupported result for another adapter", async () => {
		const unsupported = createDb({
			transactionError: new Error("Transactions are not supported"),
		});
		const supported = createDb();
		const fn = vi.fn(async () => "ok");

		await withTransaction(unsupported.db as never, fn);
		await withTransaction(supported.db as never, fn);

		expect(unsupported.execute).toHaveBeenCalledTimes(1);
		expect(supported.execute).toHaveBeenCalledTimes(1);
		expect(fn).toHaveBeenLastCalledWith(supported.trx);
	});

	it("does not retry a transaction callback that throws the unsupported message", async () => {
		const { db, execute } = createDb();
		const error = new Error("Transactions are not supported by this operation");
		const fn = vi.fn(async () => {
			throw error;
		});

		await expect(withTransaction(db as never, fn)).rejects.toBe(error);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(fn).toHaveBeenCalledTimes(1);
	});
});

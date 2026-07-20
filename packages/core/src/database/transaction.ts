/**
 * Transaction utility for D1 compatibility
 *
 * D1 (via kysely-d1) does not support transactions. On workerd, the error
 * from beginTransaction() crosses request contexts and can hang the worker.
 *
 * This utility provides a drop-in replacement that runs the callback directly
 * against the db instance when transactions are unavailable. D1 is single-writer
 * so atomicity is not a concern for individual statements — multi-statement
 * atomicity is lost, but that's a known D1 limitation.
 *
 * Usage:
 *   import { withTransaction } from "../database/transaction.js";
 *   const result = await withTransaction(db, async (trx) => { ... });
 */

import type { Kysely, Transaction } from "kysely";

/**
 * Run a callback inside a transaction if supported, or directly if not.
 *
 * Probes a given adapter once on first use to determine if transactions work.
 * The result is cached per adapter for the lifetime of the process/worker.
 */
const TRANSACTIONS_NOT_SUPPORTED_RE = /transactions are not supported/i;
const D1_ADAPTER_MARKER = Symbol.for("emdash:d1-adapter");

type TransactionSupportCache = WeakMap<object, boolean>;

const TRANSACTION_SUPPORT_CACHE_KEY = Symbol.for("emdash:transaction-support-by-adapter");
const g = globalThis as Record<symbol, unknown>;
const transactionSupportByAdapter: TransactionSupportCache =
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis singleton pattern (see request-cache.ts)
	(g[TRANSACTION_SUPPORT_CACHE_KEY] as TransactionSupportCache | undefined) ??
	(() => {
		const wm: TransactionSupportCache = new WeakMap();
		g[TRANSACTION_SUPPORT_CACHE_KEY] = wm;
		return wm;
	})();

function getAdapter<DB>(db: Kysely<DB>): object {
	return db.getExecutor().adapter as object;
}

function isMarkedD1Adapter<DB>(db: Kysely<DB>): boolean {
	return Reflect.get(getAdapter(db), D1_ADAPTER_MARKER) === true;
}

export async function withTransaction<DB, T>(
	db: Kysely<DB>,
	fn: (trx: Kysely<DB> | Transaction<DB>) => Promise<T>,
): Promise<T> {
	const adapter = getAdapter(db);
	const cachedSupport = transactionSupportByAdapter.get(adapter);

	// Fast path: we already know transactions work for this adapter
	if (cachedSupport === true) {
		return db.transaction().execute(fn);
	}

	// Fast path: we already know they don't
	if (cachedSupport === false) {
		return fn(db);
	}

	// D1 never supports Kysely transactions and probing can hang workerd.
	if (isMarkedD1Adapter(db)) {
		transactionSupportByAdapter.set(adapter, false);
		return fn(db);
	}

	// First call for this adapter: probe
	try {
		const result = await db.transaction().execute(fn);
		transactionSupportByAdapter.set(adapter, true);
		return result;
	} catch (error) {
		if (error instanceof Error && TRANSACTIONS_NOT_SUPPORTED_RE.test(error.message)) {
			transactionSupportByAdapter.set(adapter, false);
			return fn(db);
		}
		throw error;
	}
}

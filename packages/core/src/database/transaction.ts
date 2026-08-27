/**
 * Transaction utility for D1 compatibility
 *
 * D1 (via kysely-d1) does not support transactions.
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
 * Adapters can declare that transactions are unsupported. Other adapters are
 * tried once and cached only when beginTransaction rejects with the standard
 * unsupported-transaction error.
 */
const TRANSACTIONS_NOT_SUPPORTED_RE = /transactions are not supported/i;
const TRANSACTIONS_UNSUPPORTED_MARKER = Symbol.for("emdash:transactions-unsupported");
const UNSUPPORTED_ADAPTERS_KEY = Symbol.for("emdash:transaction-unsupported-adapters");

type UnsupportedAdapterCache = WeakSet<object>;

const g = globalThis as Record<symbol, unknown>;
const unsupportedAdapters: UnsupportedAdapterCache =
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis singleton pattern (see request-cache.ts)
	(g[UNSUPPORTED_ADAPTERS_KEY] as UnsupportedAdapterCache | undefined) ??
	(() => {
		const cache: UnsupportedAdapterCache = new WeakSet();
		g[UNSUPPORTED_ADAPTERS_KEY] = cache;
		return cache;
	})();

function getAdapter<DB>(db: Kysely<DB>): object {
	return db.getExecutor().adapter;
}

export async function withTransaction<DB, T>(
	db: Kysely<DB>,
	fn: (trx: Kysely<DB> | Transaction<DB>) => Promise<T>,
): Promise<T> {
	const adapter = getAdapter(db);
	if (
		unsupportedAdapters.has(adapter) ||
		Reflect.get(adapter, TRANSACTIONS_UNSUPPORTED_MARKER) === true
	) {
		unsupportedAdapters.add(adapter);
		return fn(db);
	}

	let callbackStarted = false;
	try {
		return await db.transaction().execute((trx) => {
			callbackStarted = true;
			return fn(trx);
		});
	} catch (error) {
		if (
			!callbackStarted &&
			error instanceof Error &&
			TRANSACTIONS_NOT_SUPPORTED_RE.test(error.message)
		) {
			unsupportedAdapters.add(adapter);
			return fn(db);
		}
		throw error;
	}
}

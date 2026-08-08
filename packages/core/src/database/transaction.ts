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
 * Probes the database once on first call to determine if transactions work.
 * The result is cached for the lifetime of the process/worker.
 */
let transactionsSupported: boolean | null = null;
const TRANSACTIONS_NOT_SUPPORTED_RE = /transactions are not supported/i;

export async function withTransaction<DB, T>(
	db: Kysely<DB>,
	fn: (trx: Kysely<DB> | Transaction<DB>) => Promise<T>,
): Promise<T> {
	// Nested call: `db` is already a transaction. Kysely rejects calling
	// `.transaction()` on a `Transaction` outright (a hard error, not the
	// "transactions are not supported" message the probe below expects), so a
	// naive nested `withTransaction(trx, ...)` call would always throw on any
	// dialect that supports real transactions. Running `fn` directly against
	// the existing transaction makes the nested work part of the enclosing
	// one — exactly what nested callers (e.g. a handler composing two
	// repositories that each self-wrap in `withTransaction`) want: the whole
	// chain commits or rolls back together.
	if (db.isTransaction) {
		return fn(db);
	}

	// Fast path: we already know transactions work
	if (transactionsSupported === true) {
		return db.transaction().execute(fn);
	}

	// Fast path: we already know they don't
	if (transactionsSupported === false) {
		return fn(db);
	}

	// First call: probe
	try {
		const result = await db.transaction().execute(fn);
		transactionsSupported = true;
		return result;
	} catch (error) {
		if (error instanceof Error && TRANSACTIONS_NOT_SUPPORTED_RE.test(error.message)) {
			transactionsSupported = false;
			return fn(db);
		}
		throw error;
	}
}

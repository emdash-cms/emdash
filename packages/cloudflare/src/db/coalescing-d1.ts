/**
 * Experimental coalescing D1 driver.
 *
 * Buffers SELECT queries issued in the same event-loop turn and executes
 * them as a single D1 `batch()` call (one HTTP round trip) instead of N
 * fully-serialized round trips. Production pages routinely issue 5-7
 * serialized queries at 15-40ms each; batching collapses them into one.
 *
 * Only used for the per-request session Kysely (see createRequestScopedDb
 * in d1.ts). The shared singleton must never coalesce: concurrent requests
 * would share a buffer and one request's queries could be batched into
 * another request's round trip.
 */

import {
	type CompiledQuery,
	type DatabaseConnection,
	type Driver,
	type QueryResult,
	SqliteAdapter,
} from "kysely";
import type { D1DialectConfig } from "kysely-d1";

import { EmDashD1Dialect } from "./d1-dialect.js";

/**
 * Statements safe to coalesce: plain SELECTs. Deliberately conservative —
 * `WITH` is excluded because SQLite allows CTEs on writes
 * (`WITH ... INSERT/UPDATE/DELETE`), and everything else (insert, update,
 * delete, pragma, explain, ...) takes the direct path.
 */
const SELECT_PATTERN = /^select\b/i;

interface PendingQuery {
	statement: D1PreparedStatement;
	resolve: (result: QueryResult<any>) => void;
	reject: (error: unknown) => void;
	/** SQL text, kept for error reporting. */
	sql: string;
}

/**
 * Map a D1 result to a Kysely QueryResult. Mirrors kysely-d1's mapping
 * exactly: rows from `results`, numAffectedRows from `meta.changes` as
 * BigInt when > 0, insertId from `meta.last_row_id`.
 *
 * No `success` check: the D1Result type declares `success: true`, i.e. a
 * returned result is always a success — D1 rejects the `.all()`/`.batch()`
 * promise on failure, which the callers handle (the batch catch-fallback,
 * and Kysely's own error path on the direct path).
 */
function mapD1Result<R>(result: D1Result<R>): QueryResult<R> {
	if (result.error) {
		throw new Error(result.error);
	}
	const numAffectedRows = result.meta.changes > 0 ? BigInt(result.meta.changes) : undefined;
	return {
		insertId:
			result.meta.last_row_id === undefined || result.meta.last_row_id === null
				? undefined
				: BigInt(result.meta.last_row_id),
		rows: result.results ?? [],
		numAffectedRows,
	};
}

export class CoalescingD1Connection implements DatabaseConnection {
	#database: D1Database;
	#buffer: PendingQuery[] = [];
	#flushScheduled = false;
	/**
	 * Tail of a promise chain that serializes every physical call against the
	 * shared D1DatabaseSession (direct-path statements and batch flushes
	 * alike). See #enqueue.
	 */
	#opChain: Promise<unknown> = Promise.resolve();

	constructor(database: D1Database) {
		this.#database = database;
	}

	/**
	 * Run `op` after all previously-enqueued session calls have settled, so
	 * only one physical call is ever in flight against the shared
	 * D1DatabaseSession at a time.
	 *
	 * The plain SqliteAdapter reports `supportsMultipleConnections: false`,
	 * which makes Kysely serialize every query behind a connection mutex. We
	 * override that to `true` so same-turn SELECTs can reach the buffer
	 * together — but that also removes the mutex for writes and direct-path
	 * statements. D1 sessions are sequentially consistent and advance a
	 * bookmark per executed query; overlapping calls on one session could
	 * interleave that bookmark and persist a stale one at commit(), breaking
	 * read-your-writes. This chain restores the single-in-flight invariant
	 * for physical calls while still letting SELECTs coalesce into one batch.
	 *
	 * A failed op must not break the chain, so the stored tail swallows the
	 * outcome; the returned promise still rejects for the caller.
	 */
	#enqueue<T>(op: () => Promise<T>): Promise<T> {
		const run = this.#opChain.then(op, op);
		this.#opChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
		if (!SELECT_PATTERN.test(compiledQuery.sql.trim())) {
			// Non-SELECT: execute on the direct path (kysely-d1's prepare/bind/all
			// flow), but through the op chain so it can't overlap an in-flight
			// SELECT batch or another write on the shared session.
			const statement = this.#database.prepare(compiledQuery.sql).bind(...compiledQuery.parameters);
			const result = await this.#enqueue(() => statement.all<R>());
			return mapD1Result(result);
		}

		const statement = this.#database.prepare(compiledQuery.sql).bind(...compiledQuery.parameters);

		return new Promise<QueryResult<R>>((resolve, reject) => {
			this.#buffer.push({ statement, resolve, reject, sql: compiledQuery.sql });
			this.#scheduleFlush();
		});
	}

	/**
	 * Schedule a flush of buffered SELECTs unless one is already pending.
	 *
	 * setTimeout(0) (macrotask), not queueMicrotask: Kysely awaits internally
	 * between acquiring the connection and executing each query, so a
	 * microtask window would close before sibling queries issued in the same
	 * turn reach the connection. Queries that arrive after the buffer is
	 * drained (flag already cleared) simply schedule the next window; physical
	 * ordering against any in-flight call is handled by #enqueue.
	 */
	#scheduleFlush(): void {
		if (this.#flushScheduled) return;
		this.#flushScheduled = true;
		setTimeout(() => {
			void this.#flush();
		}, 0);
	}

	async #flush(): Promise<void> {
		// Clear the scheduled flag before draining so queries arriving after
		// this point schedule a fresh window rather than being stranded.
		this.#flushScheduled = false;
		const pending = this.#buffer.splice(0, this.#buffer.length);
		if (pending.length === 0) return;

		// Serialize the physical batch/all against every other session call.
		await this.#enqueue(async () => {
			const first = pending[0];
			if (pending.length === 1 && first) {
				// A lone query gains nothing from batch(); execute it directly.
				try {
					first.resolve(mapD1Result(await first.statement.all()));
				} catch (error) {
					first.reject(error);
				}
				return;
			}

			let results: D1Result[];
			try {
				results = await this.#database.batch(pending.map((p) => p.statement));
			} catch {
				// D1 batches are atomic: one bad statement rejects the whole call.
				// Fall back to executing every buffered statement individually
				// (they are all SELECTs, safe to re-run) so innocent queries still
				// resolve and only the genuinely failing one rejects with its own
				// error. This preserves per-query error semantics. Sequential, in
				// issue order: this is an error path where determinism matters
				// more than latency, and it avoids piling concurrent retries onto
				// a database that just failed.
				for (const p of pending) {
					try {
						p.resolve(mapD1Result(await p.statement.all()));
					} catch (error) {
						p.reject(error);
					}
				}
				return;
			}

			for (let i = 0; i < pending.length; i++) {
				const entry = pending[i];
				if (!entry) continue;
				const result = results[i];
				if (result) {
					try {
						entry.resolve(mapD1Result(result));
					} catch (error) {
						entry.reject(error);
					}
				} else {
					entry.reject(new Error(`D1 batch() returned no result for statement ${i}: ${entry.sql}`));
				}
			}
		});
	}

	// eslint-disable-next-line require-yield -- D1 doesn't support streaming (same as kysely-d1)
	async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
		throw new Error("D1 Driver does not support streaming");
	}
}

export class CoalescingD1Driver implements Driver {
	#connection: CoalescingD1Connection;

	constructor(database: D1Database) {
		// A single shared connection: the whole point is for concurrent queries
		// in the same request to land in the same buffer.
		this.#connection = new CoalescingD1Connection(database);
	}

	async init(): Promise<void> {}

	async acquireConnection(): Promise<DatabaseConnection> {
		return this.#connection;
	}

	async beginTransaction(): Promise<void> {
		throw new Error("Transactions are not supported");
	}

	async commitTransaction(): Promise<void> {
		throw new Error("Transactions are not supported");
	}

	async rollbackTransaction(): Promise<void> {
		throw new Error("Transactions are not supported");
	}

	async releaseConnection(): Promise<void> {}

	async destroy(): Promise<void> {}
}

/**
 * SqliteAdapter reports `supportsMultipleConnections: false`, which makes
 * Kysely's RuntimeDriver serialize every query behind a connection mutex
 * (acquire → execute → release). Under that mutex a second query never
 * reaches the connection until the first resolves, so nothing would ever
 * coalesce. Our shared connection is explicitly safe for concurrent
 * `executeQuery` calls — that is the whole point — so report `true`.
 * Transactions are rejected by the driver regardless.
 */
class CoalescingD1Adapter extends SqliteAdapter {
	override get supportsMultipleConnections(): boolean {
		return true;
	}
}

/**
 * D1 dialect that coalesces same-turn SELECTs into a single `batch()` round
 * trip. Keeps EmDash's D1-compatible introspector.
 */
export class CoalescingD1Dialect extends EmDashD1Dialect {
	#database: D1Database;

	constructor(config: D1DialectConfig) {
		super(config);
		this.#database = config.database;
	}

	override createAdapter(): SqliteAdapter {
		return new CoalescingD1Adapter();
	}

	override createDriver(): Driver {
		return new CoalescingD1Driver(this.#database);
	}
}

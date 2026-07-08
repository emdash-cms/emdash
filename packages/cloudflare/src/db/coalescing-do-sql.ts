/**
 * Coalescing dialect for the Durable Object SQL backend.
 *
 * Buffers SELECTs issued in the same event-loop turn and executes them as a
 * single `batchQuery` RPC instead of one round trip per query. A page that
 * issues ~17 reads collapses to one round trip -- a large win when reads cross
 * a region to the primary, and still meaningful on a local replica (one RPC
 * instead of N).
 *
 * This is the default dialect for the per-request session db (see
 * `createRequestScopedDb` in do-sql.ts). The shared singleton must NEVER
 * coalesce: concurrent requests would share one buffer and one request's reads
 * could be batched into another's RPC (and its bookmark). The singleton uses
 * the plain `DOSqlDialect`.
 *
 * Mirrors the design of `coalescing-d1.ts`.
 */

import {
	type CompiledQuery,
	type DatabaseConnection,
	type DatabaseIntrospector,
	type Dialect,
	type Driver,
	type Kysely,
	type QueryResult,
	SqliteAdapter,
	SqliteQueryCompiler,
} from "kysely";

import { D1Introspector } from "./d1-introspector.js";
import type { DOSqlDialectConfig } from "./do-sql-dialect.js";
import type { EmDashDBStub } from "./do-sql-types.js";
import { isReadStatement } from "./do-sql-types.js";

/**
 * Statements safe to coalesce: plain SELECTs. Deliberately conservative --
 * `WITH` is excluded because SQLite allows CTEs on writes
 * (`WITH ... INSERT/UPDATE/DELETE`), and everything else (insert, update,
 * delete, pragma, explain, ...) takes the direct single-`query` path.
 */
const SELECT_PATTERN = /^select\b/i;

interface PendingQuery {
	sql: string;
	params: unknown[];
	resolve: (result: QueryResult<any>) => void;
	reject: (error: unknown) => void;
}

class CoalescingDOSqlConnection implements DatabaseConnection {
	readonly #stub: EmDashDBStub;
	readonly #config: DOSqlDialectConfig;
	#buffer: PendingQuery[] = [];
	#flushScheduled = false;
	/**
	 * Tail of a promise chain that serializes every physical RPC against the
	 * DO (direct-path statements and batch flushes alike), so a write and a
	 * read batch never overlap and the bookmark advances in execution order.
	 */
	#opChain: Promise<unknown> = Promise.resolve();

	constructor(stub: EmDashDBStub, config: DOSqlDialectConfig) {
		this.#stub = stub;
		this.#config = config;
	}

	/** The freshest write bookmark seen this request, else the cookie floor. */
	#effectiveBookmark(): string | undefined {
		return this.#config.bookmarkSink?.latest ?? this.#config.readBookmark;
	}

	/**
	 * Run `op` after all previously-enqueued RPCs settle, so only one physical
	 * RPC is ever in flight. We report `supportsMultipleConnections: true` to
	 * lift Kysely's per-connection mutex (so same-turn SELECTs can reach the
	 * buffer together); this chain restores the single-in-flight invariant for
	 * physical calls. A failed op must not break the chain.
	 */
	#enqueue<T>(op: () => Promise<T>): Promise<T> {
		const run = this.#opChain.then(op, op);
		this.#opChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/** Single-statement path: full `query()` semantics (bookmark, sink, writes). */
	async #single<R>(sql: string, params: unknown[]): Promise<QueryResult<R>> {
		const bookmark = isReadStatement(sql) ? this.#effectiveBookmark() : undefined;
		this.#config.onRpc?.();
		const result = await this.#stub.query(sql, params, bookmark ? { bookmark } : undefined);
		if (result.bookmark && this.#config.bookmarkSink) {
			this.#config.bookmarkSink.latest = result.bookmark;
		}
		return {
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- caller's row type; we trust the DB returned matching rows
			rows: result.rows as R[],
			numAffectedRows: result.changes !== undefined ? BigInt(result.changes) : undefined,
		};
	}

	async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- CompiledQuery.parameters is ReadonlyArray<unknown>
		const params = compiledQuery.parameters as unknown[];

		if (!SELECT_PATTERN.test(compiledQuery.sql.trimStart())) {
			// Writes and non-SELECT reads: direct path, serialized on the op chain
			// so they can't overlap an in-flight read batch or another write.
			return this.#enqueue(() => this.#single<R>(compiledQuery.sql, params));
		}

		return new Promise<QueryResult<R>>((resolve, reject) => {
			this.#buffer.push({ sql: compiledQuery.sql, params, resolve, reject });
			this.#scheduleFlush();
		});
	}

	/**
	 * setTimeout(0) (macrotask), not queueMicrotask: Kysely awaits internally
	 * between acquiring the connection and executing each query, so a microtask
	 * window would close before sibling queries issued in the same turn reach
	 * the buffer.
	 */
	#scheduleFlush(): void {
		if (this.#flushScheduled) return;
		this.#flushScheduled = true;
		setTimeout(() => {
			void this.#flush();
		}, 0);
	}

	async #flush(): Promise<void> {
		this.#flushScheduled = false;
		const pending = this.#buffer.splice(0, this.#buffer.length);
		if (pending.length === 0) return;

		await this.#enqueue(async () => {
			const first = pending[0];
			if (pending.length === 1 && first) {
				// A lone query gains nothing from a batch RPC; run it directly so
				// it keeps full query() semantics.
				try {
					first.resolve(await this.#single(first.sql, first.params));
				} catch (error) {
					first.reject(error);
				}
				return;
			}

			// Compute the bookmark inside the enqueued op so it reflects any write
			// that ran just before this flush.
			const bookmark = this.#effectiveBookmark();
			let results;
			try {
				this.#config.onRpc?.();
				results = await this.#stub.batchQuery(
					pending.map((p) => ({ sql: p.sql, params: p.params })),
					bookmark ? { bookmark } : undefined,
				);
			} catch {
				// The batch RPC failed as a unit. Fall back to running each buffered
				// statement individually (all SELECTs, safe to re-run) so innocent
				// queries still resolve and only a genuinely failing one rejects with
				// its own error. Sequential, in issue order: determinism over latency
				// on the error path.
				for (const p of pending) {
					try {
						p.resolve(await this.#single(p.sql, p.params));
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
					entry.resolve({
						// eslint-disable-next-line typescript/no-unsafe-type-assertion -- caller's row type
						rows: result.rows as unknown[],
						numAffectedRows: undefined,
					});
				} else {
					entry.reject(
						new Error(`DO batchQuery returned no result for statement ${i}: ${entry.sql}`),
					);
				}
			}
		});
	}

	// eslint-disable-next-line require-yield -- DO RPC doesn't stream
	async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
		throw new Error("DO SQL dialect does not support streaming");
	}
}

class CoalescingDOSqlDriver implements Driver {
	readonly #config: DOSqlDialectConfig;
	#connection: CoalescingDOSqlConnection | undefined;

	constructor(config: DOSqlDialectConfig) {
		this.#config = config;
	}

	async init(): Promise<void> {}

	async acquireConnection(): Promise<DatabaseConnection> {
		// One shared connection (and one stub) for the whole request: the point
		// is for concurrent queries to land in the same buffer. Resolved lazily
		// inside the request's I/O context. Safe because this dialect is only
		// ever used per-request, never for the cross-request singleton.
		this.#connection ??= new CoalescingDOSqlConnection(this.#config.resolveStub(), this.#config);
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
 * Kysely serialize every query behind a connection mutex -- nothing would ever
 * coalesce. Our shared connection is explicitly safe for concurrent
 * `executeQuery` calls (that is the point), so report `true`. Transactions are
 * rejected by the driver regardless.
 */
class CoalescingDOSqlAdapter extends SqliteAdapter {
	override get supportsMultipleConnections(): boolean {
		return true;
	}
}

export class CoalescingDOSqlDialect implements Dialect {
	readonly #config: DOSqlDialectConfig;

	constructor(config: DOSqlDialectConfig) {
		this.#config = config;
	}

	createAdapter(): SqliteAdapter {
		return new CoalescingDOSqlAdapter();
	}

	createDriver(): Driver {
		return new CoalescingDOSqlDriver(this.#config);
	}

	createQueryCompiler(): SqliteQueryCompiler {
		return new SqliteQueryCompiler();
	}

	createIntrospector(db: Kysely<any>): DatabaseIntrospector {
		return new D1Introspector(db);
	}
}

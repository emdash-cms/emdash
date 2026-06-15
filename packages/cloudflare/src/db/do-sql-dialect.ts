/**
 * Kysely dialect for the production Durable Object SQL database.
 *
 * Proxies queries to an `EmDashDB` stub via RPC. Two properties matter for
 * latency and correctness:
 *
 *   1. **One stub, reused.** The dialect resolves a single DO stub lazily (on
 *      the first query, inside a request's I/O context) and reuses it for every
 *      query. Resolving a fresh stub per query is the main source of D1-style
 *      per-query round-trip overhead; the request-scoped factory in `do-sql.ts`
 *      gives each request its own dialect, so this is "one stub per request".
 *
 *   2. **No interactive transactions**, matching D1 (kysely-d1). The driver
 *      rejects `beginTransaction` with the message EmDash's `withTransaction`
 *      helper probes for, so transaction callbacks degrade to direct execution
 *      against the primary-routed connection — the same atomicity profile the
 *      codebase already runs under on D1.
 */

import type {
	CompiledQuery,
	DatabaseConnection,
	DatabaseIntrospector,
	Dialect,
	Driver,
	Kysely,
	QueryResult,
} from "kysely";
import { SqliteAdapter, SqliteQueryCompiler } from "kysely";

import { D1Introspector } from "./d1-introspector.js";
import type { EmDashDBStub } from "./do-sql-types.js";
import { isReadStatement } from "./do-sql-types.js";

/** Mutable holder for the latest write bookmark, read by the request `commit()`. */
export interface BookmarkSink {
	latest?: string;
}

export interface DOSqlDialectConfig {
	/**
	 * Resolves the DO stub. Called once per query (per `acquireConnection`).
	 * The implementation owns the stub's lifetime: the request-scoped factory
	 * memoizes within a single request ("one stub per request"); the singleton
	 * factory returns a fresh stub each call because a DO stub cannot cross
	 * request boundaries.
	 */
	resolveStub: () => EmDashDBStub;
	/**
	 * The request's initial read-your-writes bookmark, from the client's cookie
	 * (authenticated requests only). Used as the floor for reads until a write
	 * in this request mints a fresher one into the sink.
	 */
	readBookmark?: string;
	/**
	 * Carries the latest write bookmark. Updated with the bookmark returned by
	 * each write, and consulted on subsequent reads (taking precedence over
	 * `readBookmark`) so read-after-write within a request is consistent. Also
	 * read by the request `commit()` to persist the bookmark cookie.
	 */
	bookmarkSink?: BookmarkSink;
}

export class DOSqlDialect implements Dialect {
	readonly #config: DOSqlDialectConfig;

	constructor(config: DOSqlDialectConfig) {
		this.#config = config;
	}

	createAdapter(): SqliteAdapter {
		return new SqliteAdapter();
	}

	createDriver(): Driver {
		return new DOSqlDriver(this.#config);
	}

	createQueryCompiler(): SqliteQueryCompiler {
		return new SqliteQueryCompiler();
	}

	createIntrospector(db: Kysely<any>): DatabaseIntrospector {
		return new D1Introspector(db);
	}
}

class DOSqlDriver implements Driver {
	readonly #config: DOSqlDialectConfig;

	constructor(config: DOSqlDialectConfig) {
		this.#config = config;
	}

	async init(): Promise<void> {}

	async acquireConnection(): Promise<DatabaseConnection> {
		// Resolve the stub on every acquire and let `resolveStub` decide its
		// lifetime. A DO stub is a per-request I/O object: it cannot be reused
		// across requests, so the driver must NOT cache it (the singleton dialect
		// is itself cached across requests on globalThis — caching a stub here
		// would bind it to a stale request and throw "Cannot perform I/O on
		// behalf of a different request"). The request-scoped factory passes a
		// closure that memoizes per request, giving "one stub per request"
		// without crossing request boundaries.
		return new DOSqlConnection(this.#config.resolveStub(), this.#config);
	}

	async beginTransaction(): Promise<void> {
		// Match kysely-d1: interactive transactions are unsupported. EmDash's
		// withTransaction() probes for this exact message and falls back to
		// running the callback directly against the connection.
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

class DOSqlConnection implements DatabaseConnection {
	readonly #stub: EmDashDBStub;
	readonly #config: DOSqlDialectConfig;

	constructor(stub: EmDashDBStub, config: DOSqlDialectConfig) {
		this.#stub = stub;
		this.#config = config;
	}

	async executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
		const sqlText = compiledQuery.sql;
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- CompiledQuery.parameters is ReadonlyArray<unknown>, stub expects unknown[]
		const params = compiledQuery.parameters as unknown[];

		// Forward a read-your-writes bookmark only on reads. Prefer the freshest
		// write bookmark seen this request (sink) over the request's initial
		// cookie bookmark, so a read issued AFTER a write in the same request
		// waits for that write to replicate before serving. Without this, a
		// read-after-write (e.g. create() then findById()) on a replica would
		// miss the just-written row. Writes always proxy to the primary and mint
		// a fresh bookmark, so they don't carry one inbound.
		let opts: { bookmark: string } | undefined;
		if (isReadStatement(sqlText)) {
			const bookmark = this.#config.bookmarkSink?.latest ?? this.#config.readBookmark;
			if (bookmark) opts = { bookmark };
		}

		const result = await this.#stub.query(sqlText, params, opts);

		if (result.bookmark && this.#config.bookmarkSink) {
			this.#config.bookmarkSink.latest = result.bookmark;
		}

		return {
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Kysely generic O is the caller's row type; we trust the DB returned matching rows
			rows: result.rows as O[],
			numAffectedRows: result.changes !== undefined ? BigInt(result.changes) : undefined,
		};
	}

	// eslint-disable-next-line require-yield -- interface requires AsyncIterableIterator but DO RPC doesn't stream
	async *streamQuery<O>(): AsyncIterableIterator<QueryResult<O>> {
		throw new Error("DO SQL dialect does not support streaming");
	}
}

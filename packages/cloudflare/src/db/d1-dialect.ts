/**
 * Shared D1 Kysely dialect with EmDash's D1-compatible introspector.
 *
 * Lives in its own module (rather than d1.ts) so the coalescing dialect in
 * coalescing-d1.ts can extend it without creating a circular import with
 * d1.ts, and without pulling cloudflare:workers into test environments.
 */

import type { CompoundSelectLimitedAdapter } from "emdash";
import { LockingSqliteAdapter } from "emdash/internal/database/migration-lock";
import type {
	CompiledQuery,
	DatabaseIntrospector,
	Kysely,
	QueryResult,
	SqliteAdapter,
} from "kysely";
import { D1Dialect, type D1DialectConfig } from "kysely-d1";

import { D1Introspector } from "./d1-introspector.js";

/**
 * Terms D1 allows in one compound SELECT (`UNION ALL`, `INTERSECT`, `EXCEPT`).
 * D1 sets SQLITE_LIMIT_COMPOUND_SELECT to 5 where SQLite's upstream default is
 * 500; a sixth branch is rejected with "too many terms in compound SELECT".
 * Measured against a live D1.
 */
export const D1_COMPOUND_SELECT_LIMIT = 5;

/**
 * Called once when a physical D1 call starts, with the number of statements it
 * carries. May return a callback that receives the call's summed
 * `meta.rows_read` (undefined when unavailable) once it settles; the runtime
 * only asks for that when tracing a request.
 */
export type RpcHook = (statements: number) => ((rowsRead: number | undefined) => void) | void;

/**
 * Dialect config plus an optional round-trip hook, so the runtime can count
 * round trips separately from logical queries. Injected rather than imported
 * so the dialect stays decoupled from core — same pattern as the DO SQL
 * dialect.
 */
export interface EmDashD1DialectConfig extends D1DialectConfig {
	onRpc?: RpcHook;
}

function rowsReadOf(result: unknown): number | undefined {
	if (Array.isArray(result)) {
		let total: number | undefined;
		for (const r of result) {
			const n = rowsReadOf(r);
			if (n !== undefined) total = (total ?? 0) + n;
		}
		return total;
	}
	if (result && typeof result === "object" && "meta" in result) {
		const meta: unknown = result.meta;
		if (meta && typeof meta === "object" && "rows_read" in meta) {
			return typeof meta.rows_read === "number" ? meta.rows_read : undefined;
		}
	}
	return undefined;
}

/** Report one physical call carrying `statements` statements to `onRpc`. */
export function observeRpc<T>(onRpc: RpcHook, statements: number, run: () => T): T {
	const settle = onRpc(statements);
	const out = run();
	if (settle && out instanceof Promise) {
		out.then(
			(result: unknown) => settle(rowsReadOf(result)),
			() => settle(undefined),
		);
	}
	return out;
}

/** Maps a counting statement wrapper back to the real D1 statement for batch(). */
const innerStatements = new WeakMap<object, D1PreparedStatement>();

function countingStatement(inner: D1PreparedStatement, onRpc: RpcHook): D1PreparedStatement {
	// Resolve the target method at call time, not wrap time, so a statement
	// that lacks one (e.g. a partial test double) still wraps cleanly.
	const forward =
		(method: "all" | "run" | "first" | "raw") =>
		(...args: unknown[]): unknown =>
			observeRpc(onRpc, 1, () => {
				// eslint-disable-next-line typescript/no-unsafe-type-assertion -- forwards D1's overloaded signatures unchanged
				const fn = inner[method] as (...a: unknown[]) => unknown;
				return fn.apply(inner, args);
			});
	const wrapper = {
		bind: (...values: unknown[]) => countingStatement(inner.bind(...values), onRpc),
		all: forward("all"),
		run: forward("run"),
		first: forward("first"),
		raw: forward("raw"),
	};
	innerStatements.set(wrapper, inner);
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- wrapper implements the D1PreparedStatement surface the dialects use
	return wrapper as unknown as D1PreparedStatement;
}

/**
 * Wrap a D1Database (or a D1DatabaseSession cast to one) so every physical
 * call reports to `onRpc`. Only `prepare` and `batch` are intercepted — those
 * are the only members the Kysely dialects touch. `batch()` receives the
 * wrappers and is handed the real statements, since workerd rejects foreign
 * objects there.
 */
export function countRoundTrips(database: D1Database, onRpc: RpcHook): D1Database {
	const wrapped = {
		prepare: (sql: string) => countingStatement(database.prepare(sql), onRpc),
		batch: (statements: D1PreparedStatement[]) =>
			observeRpc(onRpc, statements.length, () =>
				database.batch(statements.map((s) => innerStatements.get(s) ?? s)),
			),
		exec: (sql: string) => observeRpc(onRpc, 1, () => database.exec(sql)),
	};
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- wrapper implements the subset of D1Database the dialects use
	return wrapped as unknown as D1Database;
}

interface AtomicBatchAdapter {
	executeAtomicBatch(queries: readonly CompiledQuery[]): Promise<readonly QueryResult<unknown>[]>;
}

/**
 * Base adapter for every D1-backed dialect. Declares the compound-SELECT
 * ceiling, which core reads off the adapter to split statements that would
 * exceed it, and takes the migration lock in a database row, since D1 has no
 * lock that separate Workers and CLI processes share. A dialect that overrides
 * `createAdapter()` without extending this silently sends D1 compound SELECTs
 * it rejects and lets concurrent migrations run into each other.
 */
export class D1BaseAdapter extends LockingSqliteAdapter implements CompoundSelectLimitedAdapter {
	readonly compoundSelectLimit = D1_COMPOUND_SELECT_LIMIT;
}

export class D1Adapter extends D1BaseAdapter implements AtomicBatchAdapter {
	constructor(private readonly database: D1Database) {
		super();
	}

	async executeAtomicBatch(
		queries: readonly CompiledQuery[],
	): Promise<readonly QueryResult<unknown>[]> {
		const statements = queries.map((query) =>
			this.database.prepare(query.sql).bind(...query.parameters),
		);
		const results = await this.database.batch(statements);
		return results.map(mapD1Result);
	}
}

function mapD1Result(result: D1Result): QueryResult<unknown> {
	if (result.error) throw new Error(result.error);
	return {
		rows: result.results ?? [],
		numAffectedRows: result.meta.changes > 0 ? BigInt(result.meta.changes) : undefined,
		insertId:
			result.meta.last_row_id === undefined || result.meta.last_row_id === null
				? undefined
				: BigInt(result.meta.last_row_id),
	};
}

/**
 * Adapter for the raw-binding (non-session) D1 dialect only.
 *
 * The stock SqliteAdapter reports `supportsMultipleConnections: false`, which
 * makes Kysely's RuntimeDriver serialize every query behind a ConnectionMutex
 * (acquire → execute → release). On Workers a request canceled mid-query
 * leaves the pending I/O promise unsettled, so `releaseLock()` never runs and
 * every later `obtainLock()` waits forever — a single canceled request then
 * deadlocks the whole isolate (#2040).
 *
 * The mutex protects nothing on the raw binding: kysely-d1's D1Connection
 * rejects transactions outright, releaseConnection is a no-op, and concurrent
 * `prepare().all()` calls are independent subrequests. Reporting `true`
 * removes the deadlock class with no read-your-writes implications — there is
 * no session bookmark to protect on this path.
 *
 * This is deliberately a SEPARATE dialect (RawBindingD1Dialect) rather than a
 * change to EmDashD1Dialect: the session-backed non-coalesce path in
 * createRequestScopedDb also builds an EmDashD1Dialect, and there the mutex
 * IS load-bearing. A D1DatabaseSession advances its bookmark per executed
 * query; concurrent physical calls on one session could interleave the
 * bookmark and persist a stale one at commit(), breaking read-your-writes.
 * (The coalescing session path removes the mutex safely by adding its own
 * single-in-flight op chain — see CoalescingD1Connection — but the plain
 * session path has no such replacement, so it must keep the mutex.)
 */
class RawBindingD1Adapter extends D1Adapter {
	override get supportsMultipleConnections(): boolean {
		return true;
	}
}

/**
 * Custom D1 Dialect that uses our D1-compatible introspector
 *
 * The default kysely-d1 dialect uses SqliteIntrospector which does a
 * cross-join with pragma_table_info() that D1 doesn't allow.
 */
export class EmDashD1Dialect extends D1Dialect {
	/**
	 * The database every physical call goes through. When `onRpc` is set this
	 * is the round-trip-counting wrapper, so kysely-d1's driver and the
	 * adapter's atomic batch are both counted.
	 */
	protected readonly database: D1Database;

	constructor(config: EmDashD1DialectConfig) {
		const { onRpc, ...rest } = config;
		const database = onRpc ? countRoundTrips(rest.database, onRpc) : rest.database;
		super({ ...rest, database });
		this.database = database;
	}

	override createAdapter(): SqliteAdapter {
		return new D1Adapter(this.database);
	}

	override createIntrospector(db: Kysely<any>): DatabaseIntrospector {
		return new D1Introspector(db);
	}
}

/**
 * Dialect for the raw-binding singleton (no D1 session). Identical to
 * EmDashD1Dialect except it reports `supportsMultipleConnections: true` so
 * Kysely skips the ConnectionMutex that turns one canceled request into an
 * isolate-wide deadlock (#2040). Use ONLY for the raw binding — never for a
 * session-backed Kysely (see RawBindingD1Adapter above).
 */
export class RawBindingD1Dialect extends EmDashD1Dialect {
	override createAdapter(): SqliteAdapter {
		return new RawBindingD1Adapter(this.database);
	}
}

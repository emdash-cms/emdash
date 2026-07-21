/**
 * Shared D1 Kysely dialect with EmDash's D1-compatible introspector.
 *
 * Lives in its own module (rather than d1.ts) so the coalescing dialect in
 * coalescing-d1.ts can extend it without creating a circular import with
 * d1.ts, and without pulling cloudflare:workers into test environments.
 */

import type { DatabaseIntrospector, Kysely } from "kysely";
import { SqliteAdapter } from "kysely";
import { D1Dialect } from "kysely-d1";

import { D1Introspector } from "./d1-introspector.js";

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
class RawBindingD1Adapter extends SqliteAdapter {
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
		return new RawBindingD1Adapter();
	}
}

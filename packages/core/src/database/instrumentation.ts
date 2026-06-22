/**
 * Query instrumentation
 *
 * Dev/test-only: captures every Kysely query executed inside a request,
 * tagged with the route, method, and a caller-supplied phase (e.g. "cold"
 * or "warm"). Events are emitted as prefixed NDJSON on stdout so the
 * harness can capture them from both Node and workerd — workerd has no
 * filesystem access, but `console.log` is portable.
 *
 * The recorder lives on the request context (AsyncLocalStorage). The
 * Kysely `log` hook reads the recorder at query time and appends an
 * event. When no recorder is attached, the hook is a null check.
 */

import type { LogEvent, Logger } from "kysely";

import { getRequestContext } from "../request-context.js";

export const QUERY_LOG_ENV = "EMDASH_QUERY_LOG";
export const QUERY_LOG_PREFIX = "[emdash-query-log]";

export interface QueryEvent {
	sql: string;
	params: readonly unknown[];
	durationMs: number;
	route: string;
	method: string;
	phase: string;
}

export interface QueryRecorder {
	events: QueryEvent[];
	route: string;
	method: string;
	phase: string;
	/**
	 * Set once the recorder has been emitted, so a flush is idempotent.
	 * Without this, a fallback flush and the stream-end flush could both
	 * fire and double-emit the events.
	 */
	flushed?: boolean;
	/**
	 * Set when the response body is wrapped for stream-end metrics. The
	 * recorder is then flushed when the body finishes streaming (so it
	 * captures queries issued by components during streaming) rather than
	 * when middleware returns (headers ready, body not yet streamed).
	 */
	deferredFlush?: boolean;
}

export function createRecorder(route: string, method: string, phase: string): QueryRecorder {
	return { events: [], route, method, phase };
}

export function recordEvent(
	rec: QueryRecorder,
	sql: string,
	params: readonly unknown[],
	durationMs: number,
): void {
	rec.events.push({
		sql,
		params,
		durationMs,
		route: rec.route,
		method: rec.method,
		phase: rec.phase,
	});
}

/**
 * Emit all events from a recorder as prefixed NDJSON on stdout. The
 * harness pipes the child's stdout, filters lines beginning with
 * QUERY_LOG_PREFIX, and writes them to its own file. Using stdout means
 * the sink works uniformly in Node and in workerd (which has no fs).
 *
 * Idempotent: the first call emits and marks the recorder flushed, later
 * calls no-op. For streamed responses the flush is deferred to stream end
 * (see wrapBodyForStreamMetrics) so it captures queries issued while the
 * body is still rendering; bodyless responses fall back to a flush when
 * middleware returns.
 */
export function flushRecorder(rec: QueryRecorder): void {
	if (rec.flushed) return;
	rec.flushed = true;
	for (const e of rec.events) {
		console.log(`${QUERY_LOG_PREFIX} ${JSON.stringify(e)}`);
	}
}

/**
 * Whether query instrumentation is enabled. Read at Kysely construction
 * time and middleware entry — the env var is a process-lifetime flag, not
 * per-request. Gated via `process.env` so adapters that ship env through
 * to the worker (e.g. Miniflare via wrangler.jsonc `vars` or host env
 * pass-through) can enable it at runtime.
 */
export function isInstrumentationEnabled(): boolean {
	return Boolean(
		typeof process !== "undefined" && process.env && process.env[QUERY_LOG_ENV] === "1",
	);
}

function kyselyLog(event: LogEvent): void {
	if (event.level !== "query") return;
	const ctx = getRequestContext();
	if (!ctx) return;
	const dur = event.queryDurationMillis;
	if (ctx.metrics) {
		const m = ctx.metrics;
		m.dbCount += 1;
		m.dbTotalMs += dur;
		const finishedAt = performance.now() - m.start;
		const startedAt = finishedAt - dur;
		if (m.dbFirstOffset === null) m.dbFirstOffset = startedAt;
		m.dbLastOffset = finishedAt;
	}
	if (ctx.queryRecorder) {
		recordEvent(ctx.queryRecorder, event.query.sql, event.query.parameters, dur);
	}
}

/**
 * Returns a Kysely `log` callback. Always returns a function so per-request
 * counters (db.count, db.total, db.first, db.last) and the optional NDJSON
 * recorder both get fed. The cost over the previous "undefined when off"
 * behaviour is one `performance.now()` pair per query inside Kysely, which
 * is in the noise compared to any real query.
 */
export function kyselyLogOption(): Logger {
	return kyselyLog;
}

/**
 * Record physical database round trips for the current request.
 *
 * Called by backends that batch (the DO SQL driver coalesces same-turn SELECTs
 * into one RPC), so we can see round-trip count separately from logical query
 * count (`dbCount`, bumped by the Kysely log hook). No-op outside a request or
 * when metrics aren't attached (e.g. migrations on the singleton).
 */
export function recordRpc(count = 1): void {
	const ctx = getRequestContext();
	if (ctx?.metrics) ctx.metrics.rpcCount += count;
}

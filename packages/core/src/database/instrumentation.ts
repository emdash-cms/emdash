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

import {
	getRequestContext,
	type ReplayMetrics,
	type RequestMetrics,
	type RpcTraceEntry,
} from "../request-context.js";

export const QUERY_LOG_ENV = "EMDASH_QUERY_LOG";
export const QUERY_LOG_PREFIX = "[emdash-query-log]";
/**
 * Prefix for the one-per-request summary line emitted alongside the
 * per-query events. Distinct from QUERY_LOG_PREFIX so consumers that only
 * parse query events never see it.
 */
export const QUERY_SUMMARY_PREFIX = "[emdash-query-summary]";

/** One-per-request summary: logical query count vs physical round trips. */
export interface QuerySummary {
	route: string;
	method: string;
	phase: string;
	/** Logical queries (Kysely log hook). */
	dbCount: number;
	/**
	 * Physical database round trips, as reported by backends that call
	 * recordRpc() (DO SQL, D1). 0 for backends that don't report.
	 */
	rpcCount: number;
	/** Statements per round trip, in issue order (see RequestMetrics.rpcTrace). */
	rpcStatements?: number[];
	/** `[start, end]` ms offsets per round trip, same order as rpcStatements. */
	rpcSpans?: Array<[number, number | null]>;
	/** Summed rows_read across round trips that reported it. */
	rowsRead?: number;
	/** Speculative replay counters, when the request replayed a plan. */
	replay?: ReplayMetrics;
}

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
export function flushRecorder(rec: QueryRecorder, metrics?: RequestMetrics): void {
	if (rec.flushed) return;
	rec.flushed = true;
	for (const e of rec.events) {
		console.log(`${QUERY_LOG_PREFIX} ${JSON.stringify(e)}`);
	}
	// With metrics attached, also emit one summary line so consumers can see
	// physical round trips next to the logical query count.
	if (metrics) {
		const summary: QuerySummary = {
			route: rec.route,
			method: rec.method,
			phase: rec.phase,
			dbCount: metrics.dbCount,
			rpcCount: metrics.rpcCount,
		};
		if (metrics.rpcTrace) {
			summary.rpcStatements = metrics.rpcTrace.map((t) => t.statements);
			summary.rpcSpans = metrics.rpcTrace.map((t) => [
				Math.round(t.at),
				t.dur === undefined ? null : Math.round(t.at + t.dur),
			]);
			let rowsRead: number | undefined;
			for (const t of metrics.rpcTrace) {
				if (t.rowsRead !== undefined) rowsRead = (rowsRead ?? 0) + t.rowsRead;
			}
			if (rowsRead !== undefined) summary.rowsRead = rowsRead;
		}
		if (metrics.replay) summary.replay = { ...metrics.replay };
		console.log(`${QUERY_SUMMARY_PREFIX} ${JSON.stringify(summary)}`);
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

/**
 * Record one physical round trip carrying `statements` statements. Bumps
 * `rpcCount` like recordRpc(); on instrumented requests (query recorder
 * attached) it also appends to `rpcTrace` and returns a callback for the
 * round trip's settled `rows_read`. Returns undefined otherwise, so
 * uninstrumented requests pay nothing beyond the counter.
 */
export function recordRoundTrip(
	statements: number,
): ((rowsRead: number | undefined) => void) | undefined {
	const ctx = getRequestContext();
	const metrics = ctx?.metrics;
	if (!metrics) return undefined;
	metrics.rpcCount += 1;
	if (!ctx.queryRecorder) return undefined;
	const entry: RpcTraceEntry = { statements, at: performance.now() - metrics.start };
	(metrics.rpcTrace ??= []).push(entry);
	return (rowsRead) => {
		entry.dur = performance.now() - metrics.start - entry.at;
		if (rowsRead !== undefined) entry.rowsRead = rowsRead;
	};
}

/**
 * Attach a backend's live replay counters to the current request, so they
 * show in Server-Timing and the query summary. The object is read, not
 * copied, so later updates are seen. No-op outside a request.
 */
export function attachReplayMetrics(counters: ReplayMetrics): void {
	const metrics = getRequestContext()?.metrics;
	if (metrics) metrics.replay = counters;
}

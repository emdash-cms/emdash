/**
 * EmDash Request Context
 *
 * Uses AsyncLocalStorage to provide request-scoped state to query functions
 * without requiring explicit parameter passing. The middleware wraps next()
 * in als.run(), making the context available to all code during rendering.
 *
 * Middleware always wraps each request in a context so per-request
 * metrics (db.*, cache.*) can be surfaced via Server-Timing. The cost is
 * one ALS frame per request — sub-microsecond, negligible compared to
 * any real work.
 *
 * The AsyncLocalStorage instance is stored on globalThis with a Symbol key
 * to guarantee a singleton even when bundlers duplicate this module across
 * code-split chunks. Without this, Rollup/Vite may inline the module into
 * multiple chunks (e.g. middleware and page components), each with its own
 * ALS instance — breaking request-scoped state propagation.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { QueryRecorder } from "./database/instrumentation.js";

/**
 * Lightweight always-on counters surfaced in Server-Timing.
 *
 * Bumped by the Kysely log hook (db queries) and by `requestCached`
 * (cache hits/misses). Read by middleware after the response is
 * generated to emit `db.*` and `cache.*` Server-Timing fields.
 *
 * Offsets are milliseconds from `start` (the request's entry into
 * middleware), captured via `performance.now()`.
 */
export interface RequestMetrics {
	start: number;
	dbCount: number;
	dbTotalMs: number;
	dbFirstOffset: number | null;
	dbLastOffset: number | null;
	cacheHits: number;
	cacheMisses: number;
}

export function createRequestMetrics(start: number): RequestMetrics {
	return {
		start,
		dbCount: 0,
		dbTotalMs: 0,
		dbFirstOffset: null,
		dbLastOffset: null,
		cacheHits: 0,
		cacheMisses: 0,
	};
}

export interface EmDashRequestContext {
	/** Whether the current request is in visual editing mode */
	editMode: boolean;
	/** Preview token info, if this is a preview request */
	preview?: {
		collection: string;
		id: string;
	};
	/** Current locale from Astro's i18n routing (when configured) */
	locale?: string;
	/**
	 * Per-request database override.
	 *
	 * Set by middleware when D1 read replica sessions are enabled.
	 * The runtime's `db` getter checks this first, falling back to
	 * the singleton instance. Also used by the DO preview pattern.
	 */
	db?: unknown;
	/**
	 * Indicates the per-request `db` points at an isolated database
	 * instance whose schema may diverge from the configured one
	 * (playground, DO preview sessions). When true, schema-derived caches
	 * (manifest, taxonomy defs, etc.) must not be reused across requests.
	 *
	 * Plain D1 Sessions API routing does NOT set this — sessions are just
	 * a routing hint over the same schema, so the module-scoped manifest
	 * cache remains valid.
	 */
	dbIsIsolated?: boolean;
	/**
	 * Query recorder attached by middleware when EMDASH_QUERY_LOG_FILE is set.
	 * The Kysely `log` hook appends an event per query; middleware flushes
	 * to NDJSON after the response.
	 */
	queryRecorder?: QueryRecorder;
	/**
	 * Per-request metrics for Server-Timing. Always attached by middleware
	 * for requests that emit timing headers; bumped by the Kysely log hook
	 * and `requestCached`.
	 */
	metrics?: RequestMetrics;
}

const ALS_KEY = Symbol.for("emdash:request-context");

const storage: AsyncLocalStorage<EmDashRequestContext> =
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- globalThis singleton pattern
	((globalThis as Record<symbol, unknown>)[ALS_KEY] as
		| AsyncLocalStorage<EmDashRequestContext>
		| undefined) ??
	(() => {
		const als = new AsyncLocalStorage<EmDashRequestContext>();
		(globalThis as Record<symbol, unknown>)[ALS_KEY] = als;
		return als;
	})();

/**
 * Run a function within an EmDash request context.
 * Called by middleware to wrap next().
 */
export function runWithContext<T>(ctx: EmDashRequestContext, fn: () => T): T {
	return storage.run(ctx, fn);
}

/**
 * Get the current request context.
 * Returns undefined if no context is set (logged-out fast path).
 */
export function getRequestContext(): EmDashRequestContext | undefined {
	return storage.getStore();
}

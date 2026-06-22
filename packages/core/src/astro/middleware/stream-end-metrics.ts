/**
 * Stream-end metrics
 *
 * Server-Timing db.* counters are snapshotted when middleware's next()
 * returns — but at that point only the response *headers* are final.
 * Astro streams the body afterwards, and components rendered during
 * streaming issue further DB queries that the headers can never report.
 *
 * This module wraps the response body in an identity TransformStream and
 * snapshots the request metrics in flush(), i.e. when the body actually
 * finishes streaming. The metrics object lives on the request context
 * (AsyncLocalStorage) and is mutated in-place by the Kysely log hook, so
 * a reference captured before wrapping observes every post-header query.
 * The snapshot is emitted as prefixed NDJSON on stdout (same transport as
 * [emdash-query-log] — console.log works in both Node and workerd).
 *
 * Gated on isInstrumentationEnabled() (EMDASH_QUERY_LOG=1): zero overhead
 * in normal production traffic.
 */

import { flushRecorder, isInstrumentationEnabled } from "../../database/instrumentation.js";
import { getRequestContext } from "../../request-context.js";

export const STREAM_END_PREFIX = "[emdash-stream-end]";

/**
 * Astro attaches AstroCookies to outgoing responses via a well-known global
 * symbol. Constructing a new Response drops non-header metadata, so the
 * symbol must be forwarded explicitly or `cookies.set()` calls are silently
 * dropped. Same pattern as finalizeResponse in ../middleware.ts.
 */
const ASTRO_COOKIES_SYMBOL = Symbol.for("astro.cookies");

/** Shape of the NDJSON snapshot emitted when the body finishes streaming. */
export interface StreamEndSnapshot {
	route?: string;
	method?: string;
	phase?: string;
	/** Total elapsed ms from middleware entry to end of body streaming. */
	totalMs: number;
	dbCount: number;
	dbTotalMs: number;
	dbFirstOffset: number | null;
	dbLastOffset: number | null;
	cacheHits: number;
	cacheMisses: number;
}

/**
 * Wrap a response body so the FINAL request metrics are emitted when the
 * body finishes streaming. Returns the response unchanged when
 * instrumentation is disabled, the body is null, or no request metrics
 * are attached (e.g. outside the middleware's ALS context).
 */
export function wrapBodyForStreamMetrics(response: Response): Response {
	if (!isInstrumentationEnabled()) return response;
	if (!response.body) return response;

	// Capture the context's metrics object BEFORE wrapping: flush() runs
	// after the middleware's ALS frame may have exited, but the object
	// reference stays live and is mutated in-place by the Kysely log hook.
	const ctx = getRequestContext();
	const metrics = ctx?.metrics;
	if (!metrics) return response;
	const recorder = ctx?.queryRecorder;

	// Claim the per-query flush: the recorder is mutated in-place by the
	// Kysely log hook for the whole request, including queries issued by
	// components while the body streams. Flushing here (rather than when
	// middleware returns) is what captures those streaming queries. The
	// flag tells the middleware's fallback flush to leave this recorder
	// to us.
	if (recorder) recorder.deferredFlush = true;

	const transform = new TransformStream<Uint8Array, Uint8Array>({
		flush() {
			const snapshot: StreamEndSnapshot = {
				route: recorder?.route,
				method: recorder?.method,
				phase: recorder?.phase,
				totalMs: performance.now() - metrics.start,
				dbCount: metrics.dbCount,
				dbTotalMs: metrics.dbTotalMs,
				dbFirstOffset: metrics.dbFirstOffset,
				dbLastOffset: metrics.dbLastOffset,
				cacheHits: metrics.cacheHits,
				cacheMisses: metrics.cacheMisses,
			};
			console.log(`${STREAM_END_PREFIX} ${JSON.stringify(snapshot)}`);
			// Emit the full per-query log now that streaming is complete.
			if (recorder) flushRecorder(recorder);
		},
	});

	const wrapped = new Response(response.body.pipeThrough(transform), response);
	const astroCookies = Reflect.get(response, ASTRO_COOKIES_SYMBOL);
	if (astroCookies !== undefined) {
		Reflect.set(wrapped, ASTRO_COOKIES_SYMBOL, astroCookies);
	}
	// The identity transform preserves byte counts today, but a stale
	// Content-Length on a re-constructed streaming Response risks
	// truncation if anything upstream changes; the header is recomputed
	// (or chunked encoding used) by the server layer anyway.
	wrapped.headers.delete("Content-Length");
	return wrapped;
}

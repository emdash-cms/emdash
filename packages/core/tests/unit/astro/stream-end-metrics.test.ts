import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	STREAM_END_PREFIX,
	wrapBodyForStreamMetrics,
} from "../../../src/astro/middleware/stream-end-metrics.js";
import {
	QUERY_LOG_ENV,
	QUERY_LOG_PREFIX,
	QUERY_SUMMARY_PREFIX,
	createRecorder,
	flushRecorder,
	recordEvent,
	recordRoundTrip,
} from "../../../src/database/instrumentation.js";
import {
	createRequestMetrics,
	runWithContext,
	type RequestMetrics,
} from "../../../src/request-context.js";

const ASTRO_COOKIES_SYMBOL = Symbol.for("astro.cookies");

/** Wrap inside an ALS frame carrying `metrics`, the way middleware does. */
function wrapInContext(
	response: Response,
	metrics: RequestMetrics,
	extra: { queryRecorder?: ReturnType<typeof createRecorder> } = {},
): Response {
	return runWithContext({ editMode: false, metrics, ...extra }, () =>
		wrapBodyForStreamMetrics(response),
	);
}

/** Collect every console.log line that carries the stream-end prefix. */
function captureStreamEndLines(): { lines: string[]; spy: ReturnType<typeof vi.spyOn> } {
	const lines: string[] = [];
	const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		const line = args.map(String).join(" ");
		if (line.startsWith(STREAM_END_PREFIX)) lines.push(line);
	});
	return { lines, spy };
}

function parseSnapshot(line: string): Record<string, unknown> {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- test helper parsing our own NDJSON
	return JSON.parse(line.slice(STREAM_END_PREFIX.length + 1)) as Record<string, unknown>;
}

/** Collect every console.log line that carries the query-log prefix. */
function captureQueryLogLines(): { lines: string[]; spy: ReturnType<typeof vi.spyOn> } {
	const lines: string[] = [];
	const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		const line = args.map(String).join(" ");
		if (line.startsWith(QUERY_LOG_PREFIX)) lines.push(line);
	});
	return { lines, spy };
}

describe("wrapBodyForStreamMetrics", () => {
	beforeEach(() => {
		vi.stubEnv(QUERY_LOG_ENV, "1");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("returns the response unchanged when instrumentation is disabled", () => {
		vi.stubEnv(QUERY_LOG_ENV, "");
		const metrics = createRequestMetrics(performance.now());
		const response = new Response("hello");
		const wrapped = wrapInContext(response, metrics);
		expect(wrapped).toBe(response);
	});

	it("returns a null-body response unchanged", () => {
		const metrics = createRequestMetrics(performance.now());
		const response = new Response(null, { status: 204 });
		const wrapped = wrapInContext(response, metrics);
		expect(wrapped).toBe(response);
	});

	it("returns the response unchanged when no request metrics are attached", () => {
		const response = new Response("hello");
		// No ALS frame at all — e.g. a code path outside middleware.
		const wrapped = wrapBodyForStreamMetrics(response);
		expect(wrapped).toBe(response);
	});

	it("passes body bytes through unchanged", async () => {
		const { lines } = captureStreamEndLines();
		const metrics = createRequestMetrics(performance.now());
		const body = "<html><body>chunked content éè—</body></html>";
		const response = new Response(body, {
			status: 201,
			headers: { "Content-Type": "text/html", "X-Custom": "kept" },
		});

		const wrapped = wrapInContext(response, metrics);
		expect(wrapped).not.toBe(response);
		expect(wrapped.status).toBe(201);
		expect(wrapped.headers.get("Content-Type")).toBe("text/html");
		expect(wrapped.headers.get("X-Custom")).toBe("kept");
		await expect(wrapped.text()).resolves.toBe(body);
		expect(lines).toHaveLength(1);
	});

	it("snapshots metrics at stream end, including queries recorded after headers", async () => {
		const { lines } = captureStreamEndLines();
		const metrics = createRequestMetrics(performance.now());
		// State at "headers sent" time: one query.
		metrics.dbCount = 1;
		metrics.dbTotalMs = 3;
		metrics.dbFirstOffset = 1;
		metrics.dbLastOffset = 4;

		const wrapped = wrapInContext(new Response("streamed page"), metrics);

		// Simulate the Kysely log hook firing during body streaming: the
		// metrics object is mutated in-place after the response was wrapped.
		metrics.dbCount = 7;
		metrics.dbTotalMs = 120.5;
		metrics.dbLastOffset = 250;
		metrics.cacheHits = 3;
		metrics.cacheMisses = 2;

		expect(lines).toHaveLength(0); // nothing emitted before the body drains
		await wrapped.text();
		expect(lines).toHaveLength(1);

		const snapshot = parseSnapshot(lines[0]!);
		expect(snapshot).toMatchObject({
			dbCount: 7,
			dbTotalMs: 120.5,
			dbFirstOffset: 1,
			dbLastOffset: 250,
			cacheHits: 3,
			cacheMisses: 2,
		});
		expect(typeof snapshot.totalMs).toBe("number");
		expect(snapshot.totalMs).toBeGreaterThanOrEqual(0);
	});

	it("includes route, method, and phase from the query recorder", async () => {
		const { lines } = captureStreamEndLines();
		const metrics = createRequestMetrics(performance.now());
		const queryRecorder = createRecorder("/posts", "GET", "cold");

		const wrapped = wrapInContext(new Response("page"), metrics, { queryRecorder });
		await wrapped.text();

		expect(lines).toHaveLength(1);
		expect(parseSnapshot(lines[0]!)).toMatchObject({
			route: "/posts",
			method: "GET",
			phase: "cold",
		});
	});

	it("defers the recorder flush to stream end, capturing queries recorded after headers", async () => {
		const { lines } = captureQueryLogLines();
		const metrics = createRequestMetrics(performance.now());
		const recorder = createRecorder("/posts/example", "GET", "cold");
		// One query before headers are sent (frontmatter phase).
		recordEvent(recorder, "select 1", [], 1);

		const wrapped = wrapInContext(new Response("streamed page"), metrics, {
			queryRecorder: recorder,
		});

		// Wrapping claims the flush so the middleware fallback leaves it to us.
		expect(recorder.deferredFlush).toBe(true);

		// Two more queries issued by components while the body streams.
		recordEvent(recorder, "select 2", [], 1);
		recordEvent(recorder, "select 3", [], 1);

		// Nothing emitted before the body drains.
		expect(lines).toHaveLength(0);

		await wrapped.text();

		// All three queries are emitted, including the post-header ones.
		expect(lines).toHaveLength(3);
		expect(lines.some((l) => l.includes("select 2"))).toBe(true);
		expect(lines.some((l) => l.includes("select 3"))).toBe(true);
	});

	it("is idempotent: a fallback flush after stream end does not double-emit", async () => {
		const { lines } = captureQueryLogLines();
		const metrics = createRequestMetrics(performance.now());
		const recorder = createRecorder("/posts/example", "GET", "warm");
		recordEvent(recorder, "select 1", [], 1);

		const wrapped = wrapInContext(new Response("page"), metrics, { queryRecorder: recorder });
		await wrapped.text();
		expect(lines).toHaveLength(1);

		// A late fallback flush (e.g. the middleware finally) must no-op.
		flushRecorder(recorder);
		expect(lines).toHaveLength(1);
	});

	it("emits one query summary line with dbCount and rpcCount at stream end", async () => {
		const summaries: string[] = [];
		const queryLines: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			const line = args.map(String).join(" ");
			if (line.startsWith(QUERY_SUMMARY_PREFIX)) summaries.push(line);
			if (line.startsWith(QUERY_LOG_PREFIX)) queryLines.push(line);
		});
		const metrics = createRequestMetrics(performance.now());
		const recorder = createRecorder("/posts/example", "GET", "cold");
		recordEvent(recorder, "select 1", [], 1);
		recordEvent(recorder, "select 2", [], 1);
		metrics.dbCount = 2;
		metrics.rpcCount = 1;

		const wrapped = wrapInContext(new Response("page"), metrics, { queryRecorder: recorder });
		await wrapped.text();
		flushRecorder(recorder, metrics);

		// The summary uses its own prefix, so query-log consumers never see it.
		expect(queryLines).toHaveLength(2);
		expect(summaries).toHaveLength(1);
		expect(JSON.parse(summaries[0]!.slice(QUERY_SUMMARY_PREFIX.length + 1))).toEqual({
			route: "/posts/example",
			method: "GET",
			phase: "cold",
			dbCount: 2,
			rpcCount: 1,
		});
	});

	it("forwards the Astro cookies symbol and drops Content-Length", () => {
		const metrics = createRequestMetrics(performance.now());
		const cookiesMarker = { _marker: "astro-cookies" };
		const response = new Response("hello", {
			headers: { "Content-Length": "5" },
		});
		Reflect.set(response, ASTRO_COOKIES_SYMBOL, cookiesMarker);

		const wrapped = wrapInContext(response, metrics);
		expect(wrapped).not.toBe(response);
		expect(Reflect.get(wrapped, ASTRO_COOKIES_SYMBOL)).toBe(cookiesMarker);
		expect(wrapped.headers.has("Content-Length")).toBe(false);
	});
});

describe("recordRoundTrip", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("only counts on requests without a query recorder", () => {
		const metrics = createRequestMetrics(performance.now());
		const done = runWithContext({ editMode: false, metrics }, () => recordRoundTrip(3));
		expect(done).toBeUndefined();
		expect(metrics.rpcCount).toBe(1);
		expect(metrics.rpcTrace).toBeUndefined();
	});

	it("traces statements and rows read into the summary line", () => {
		const summaries: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			const line = args.map(String).join(" ");
			if (line.startsWith(QUERY_SUMMARY_PREFIX)) summaries.push(line);
		});
		const metrics = createRequestMetrics(performance.now());
		const recorder = createRecorder("/", "GET", "cold");
		runWithContext({ editMode: false, metrics, queryRecorder: recorder }, () => {
			recordRoundTrip(5)?.(40);
			recordRoundTrip(1)?.(undefined);
			recordRoundTrip(2)?.(2);
		});
		metrics.replay = { hits: 4, misses: 1, waste: 0 };
		flushRecorder(recorder, metrics);

		const summary = JSON.parse(summaries[0]!.slice(QUERY_SUMMARY_PREFIX.length + 1));
		expect(summary.rpcCount).toBe(3);
		expect(summary.rpcStatements).toEqual([5, 1, 2]);
		expect(summary.rpcSpans).toHaveLength(3);
		expect(summary.rowsRead).toBe(42);
		expect(summary.replay).toEqual({ hits: 4, misses: 1, waste: 0 });
	});
});

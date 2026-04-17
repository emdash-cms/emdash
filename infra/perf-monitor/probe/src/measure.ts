/** Measurement logic -- runs inside the placed probe Worker. */

export interface MeasureRequest {
	targetUrl: string;
	routes: Array<{ path: string; label: string }>;
	warmRequests: number;
}

/**
 * Parsed Server-Timing header. Keyed by timing name. `desc` is optional.
 * Example: { render: { dur: 42, desc: "Page render" }, mw: { dur: 58 } }
 */
export type ServerTimings = Record<string, { dur: number; desc?: string }>;

export interface RouteResult {
	path: string;
	label: string;
	coldTtfbMs: number;
	warmTtfbMs: number;
	p95TtfbMs: number;
	statusCode: number;
	cfColo: string | null;
	cfPlacement: string | null;
	/** Parsed from the cold response. Null if header absent or unparseable. */
	coldServerTimings: ServerTimings | null;
	/**
	 * Median of each Server-Timing metric across all warm requests.
	 * Null if no warm responses carried the header or no warm requests
	 * were issued. Use this to isolate steady-state render/middleware/
	 * runtime cost, independent of cold-start.
	 */
	warmServerTimings: ServerTimings | null;
}

export interface MeasureResponse {
	results: RouteResult[];
	probeRegion: string;
}

/**
 * Parse the Server-Timing response header.
 *
 * Grammar (RFC 8673 §2):
 *   Server-Timing: metric[;param]*[, metric[;param]*]*
 *   param = dur=<number> | desc="<string>" | desc=<token>
 *
 * We only extract `dur` and `desc` and silently skip malformed entries.
 * Unknown params are ignored rather than rejected so future additions
 * upstream don't cause us to drop data.
 */
export function parseServerTiming(header: string | null): ServerTimings | null {
	if (!header) return null;
	const out: ServerTimings = {};
	for (const rawEntry of header.split(",")) {
		const parts = rawEntry.split(";").map((p) => p.trim());
		const name = parts[0];
		if (!name) continue;
		const entry: { dur: number; desc?: string } = { dur: 0 };
		let sawDur = false;
		for (const param of parts.slice(1)) {
			const eq = param.indexOf("=");
			if (eq === -1) continue;
			const key = param.slice(0, eq).trim();
			let value = param.slice(eq + 1).trim();
			// desc may be quoted
			if (value.startsWith('"') && value.endsWith('"')) {
				value = value.slice(1, -1);
			}
			if (key === "dur") {
				const n = Number(value);
				if (Number.isFinite(n)) {
					entry.dur = n;
					sawDur = true;
				}
			} else if (key === "desc") {
				entry.desc = value;
			}
		}
		if (sawDur) out[name] = entry;
	}
	return Object.keys(out).length > 0 ? out : null;
}

/**
 * Measure TTFB for a single URL.
 * Returns wall-clock time from fetch start to first byte (headers received).
 */
async function measureTtfb(url: string): Promise<{
	ttfbMs: number;
	statusCode: number;
	cfColo: string | null;
	cfPlacement: string | null;
	serverTimings: ServerTimings | null;
}> {
	const start = performance.now();
	const response = await fetch(url, {
		method: "GET",
		headers: {
			"User-Agent": "emdash-perf-probe/1.0",
			// Bust any edge cache
			"Cache-Control": "no-cache",
		},
		redirect: "follow",
	});
	const ttfbMs = performance.now() - start;

	// Consume the body so the connection is properly released
	await response.arrayBuffer();

	// Extract cf-ray colo: format is "<ray-id>-<COLO>"
	const cfRay = response.headers.get("cf-ray");
	const cfColo = cfRay?.split("-").pop() ?? null;
	const cfPlacement = response.headers.get("cf-placement");
	const serverTimings = parseServerTiming(response.headers.get("server-timing"));

	return { ttfbMs, statusCode: response.status, cfColo, cfPlacement, serverTimings };
}

/** Compute the median of an array. */
function median(values: number[]): number {
	const sorted = values.toSorted((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 0) {
		return (sorted[mid - 1]! + sorted[mid]!) / 2;
	}
	return sorted[mid]!;
}

/** Compute p95 of an array. */
function p95(values: number[]): number {
	const sorted = values.toSorted((a, b) => a - b);
	const idx = Math.ceil(sorted.length * 0.95) - 1;
	return sorted[Math.max(0, idx)]!;
}

/**
 * Run measurements for all routes.
 * For each route: 1 cold request (cache-busted with unique query param),
 * then N warm requests. Returns structured results.
 */
export async function measureRoutes(req: MeasureRequest): Promise<RouteResult[]> {
	const results: RouteResult[] = [];

	for (const route of req.routes) {
		const url = `${req.targetUrl}${route.path}`;

		// Cold request -- add a unique query param to avoid any isolate reuse
		const coldUrl = url + (url.includes("?") ? "&" : "?") + `_perf_cold=${Date.now()}`;
		const cold = await measureTtfb(coldUrl);

		// Warm requests — keep per-metric samples so we can median each one.
		const warmTimings: number[] = [];
		const warmMetricSamples: Record<string, { durs: number[]; desc?: string }> = {};
		let lastStatusCode = cold.statusCode;
		for (let i = 0; i < req.warmRequests; i++) {
			const warm = await measureTtfb(url);
			warmTimings.push(warm.ttfbMs);
			lastStatusCode = warm.statusCode;
			if (warm.serverTimings) {
				for (const [name, entry] of Object.entries(warm.serverTimings)) {
					const acc = warmMetricSamples[name] ?? { durs: [], desc: entry.desc };
					acc.durs.push(entry.dur);
					if (!acc.desc && entry.desc) acc.desc = entry.desc;
					warmMetricSamples[name] = acc;
				}
			}
		}

		// Collapse per-metric samples into medians so the stored shape
		// mirrors coldServerTimings.
		const warmServerTimings: ServerTimings | null = Object.keys(warmMetricSamples).length
			? Object.fromEntries(
					Object.entries(warmMetricSamples).map(([name, { durs, desc }]) => {
						const entry: { dur: number; desc?: string } = {
							dur: Math.round(median(durs) * 100) / 100,
						};
						if (desc) entry.desc = desc;
						return [name, entry];
					}),
				)
			: null;

		results.push({
			path: route.path,
			label: route.label,
			coldTtfbMs: Math.round(cold.ttfbMs * 100) / 100,
			warmTtfbMs: Math.round(median(warmTimings) * 100) / 100,
			p95TtfbMs: Math.round(p95(warmTimings) * 100) / 100,
			statusCode: lastStatusCode,
			cfColo: cold.cfColo,
			cfPlacement: cold.cfPlacement,
			coldServerTimings: cold.serverTimings,
			warmServerTimings,
		});
	}

	return results;
}

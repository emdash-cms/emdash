/** Measurement logic -- runs inside the placed probe Worker. */

export interface MeasureRequest {
	targetUrl: string;
	routes: Array<{ path: string; label: string }>;
	warmRequests: number;
}

export interface RouteResult {
	path: string;
	label: string;
	coldTtfbMs: number;
	warmTtfbMs: number;
	p95TtfbMs: number;
	statusCode: number;
	cfColo: string | null;
	cfPlacement: string | null;
}

export interface MeasureResponse {
	results: RouteResult[];
	probeRegion: string;
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

	return { ttfbMs, statusCode: response.status, cfColo, cfPlacement };
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

		// Warm requests
		const warmTimings: number[] = [];
		let lastStatusCode = cold.statusCode;
		for (let i = 0; i < req.warmRequests; i++) {
			const warm = await measureTtfb(url);
			warmTimings.push(warm.ttfbMs);
			lastStatusCode = warm.statusCode;
		}

		results.push({
			path: route.path,
			label: route.label,
			coldTtfbMs: Math.round(cold.ttfbMs * 100) / 100,
			warmTtfbMs: Math.round(median(warmTimings) * 100) / 100,
			p95TtfbMs: Math.round(p95(warmTimings) * 100) / 100,
			statusCode: lastStatusCode,
			cfColo: cold.cfColo,
			cfPlacement: cold.cfPlacement,
		});
	}

	return results;
}

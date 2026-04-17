/** HTTP API router for the perf monitor. */

import { TARGET_ROUTES, TARGET_URL, REGIONS, REGION_LABELS } from "./routes.js";
import { queryResults, getLatestResults, getRollingMedians, getDeployResults } from "./store.js";

/** Route the request to the correct handler. */
export async function handleApi(request: Request, url: URL, env: Env): Promise<Response | null> {
	const path = url.pathname;

	if (path === "/api/results" && request.method === "GET") {
		return handleResults(url, env);
	}
	if (path === "/api/summary" && request.method === "GET") {
		return handleSummary(env);
	}
	if (path === "/api/chart" && request.method === "GET") {
		return handleChart(url, env);
	}
	if (path === "/api/config" && request.method === "GET") {
		return handleConfig();
	}

	return null;
}

/** Narrow a query string to the allowed source values without a cast. */
function parseSource(raw: string | null): "deploy" | "cron" | undefined {
	if (raw === "deploy" || raw === "cron") return raw;
	return undefined;
}

/** GET /api/results?route=X&region=Y&source=Z&since=ISO&limit=N */
async function handleResults(url: URL, env: Env): Promise<Response> {
	const source = parseSource(url.searchParams.get("source"));

	const results = await queryResults(env.DB, {
		route: url.searchParams.get("route") ?? undefined,
		region: url.searchParams.get("region") ?? undefined,
		source,
		since: url.searchParams.get("since") ?? undefined,
		limit: url.searchParams.has("limit") ? parseInt(url.searchParams.get("limit")!, 10) : undefined,
	});

	return Response.json({ results });
}

/** GET /api/summary -- latest per route+region, rolling averages */
async function handleSummary(env: Env): Promise<Response> {
	const [latest, medians] = await Promise.all([
		getLatestResults(env.DB),
		getRollingMedians(env.DB),
	]);

	return Response.json({
		latest,
		medians,
		config: {
			routes: TARGET_ROUTES,
			regions: REGIONS.map((r) => ({ id: r, label: REGION_LABELS[r] })),
		},
	});
}

/** GET /api/chart?route=X&region=Y&since=ISO&limit=N -- time series data */
async function handleChart(url: URL, env: Env): Promise<Response> {
	const route = url.searchParams.get("route");
	const region = url.searchParams.get("region");

	if (!route || !region) {
		return Response.json({ error: "route and region are required" }, { status: 400 });
	}

	const since = url.searchParams.get("since") ?? undefined;
	const limit = url.searchParams.has("limit") ? parseInt(url.searchParams.get("limit")!, 10) : 200;

	const [results, deployResults] = await Promise.all([
		queryResults(env.DB, { route, region, since, limit }),
		getDeployResults(env.DB, since),
	]);

	// Query returns DESC -- reverse to chronological
	results.reverse();

	// Deduplicate deploy results by SHA — multiple route/region combos produce
	// duplicates, but we only want one marker per deploy on the chart.
	const seenShas = new Set<string>();
	const deployMarkers = deployResults
		.filter((r) => {
			if (!r.sha) return false;
			if (r.route !== route || r.region !== region) return false;
			if (seenShas.has(r.sha)) return false;
			seenShas.add(r.sha);
			return true;
		})
		.map((r) => ({
			timestamp: r.timestamp,
			prNumber: r.pr_number,
			sha: r.sha,
			coldTtfbMs: r.cold_ttfb_ms,
		}));

	return Response.json({
		route,
		region,
		data: results.map((r) => ({
			timestamp: r.timestamp,
			coldTtfbMs: r.cold_ttfb_ms,
			warmTtfbMs: r.warm_ttfb_ms,
			p95TtfbMs: r.p95_ttfb_ms,
			source: r.source,
			sha: r.sha,
			prNumber: r.pr_number,
		})),
		deployMarkers,
	});
}

/** GET /api/config -- target site, available routes, and regions */
async function handleConfig(): Promise<Response> {
	return Response.json({
		target: TARGET_URL,
		routes: TARGET_ROUTES,
		regions: REGIONS.map((r) => ({ id: r, label: REGION_LABELS[r] })),
	});
}

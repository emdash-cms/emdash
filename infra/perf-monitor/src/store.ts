/** D1 storage layer for perf results. */

export interface PerfResult {
	id: string;
	sha: string | null;
	pr_number: number | null;
	route: string;
	region: string;
	cold_ttfb_ms: number | null;
	warm_ttfb_ms: number | null;
	p95_ttfb_ms: number | null;
	status_code: number | null;
	cf_colo: string | null;
	cf_placement: string | null;
	timestamp: string;
	source: string;
}

export interface InsertParams {
	id: string;
	sha: string | null;
	prNumber: number | null;
	route: string;
	region: string;
	coldTtfbMs: number | null;
	warmTtfbMs: number | null;
	p95TtfbMs: number | null;
	statusCode: number | null;
	cfColo: string | null;
	cfPlacement: string | null;
	source: "deploy" | "cron";
}

/** Insert a single measurement result. */
export async function insertResult(db: D1Database, params: InsertParams): Promise<void> {
	await db
		.prepare(
			`INSERT INTO perf_results
			(id, sha, pr_number, route, region, cold_ttfb_ms, warm_ttfb_ms, p95_ttfb_ms, status_code, cf_colo, cf_placement, source)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			params.id,
			params.sha,
			params.prNumber,
			params.route,
			params.region,
			params.coldTtfbMs,
			params.warmTtfbMs,
			params.p95TtfbMs,
			params.statusCode,
			params.cfColo,
			params.cfPlacement,
			params.source,
		)
		.run();
}

/** Insert a batch of results in a single transaction. */
export async function insertResults(db: D1Database, results: InsertParams[]): Promise<void> {
	const stmt = db.prepare(
		`INSERT INTO perf_results
		(id, sha, pr_number, route, region, cold_ttfb_ms, warm_ttfb_ms, p95_ttfb_ms, status_code, cf_colo, cf_placement, source)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);

	const batch = results.map((p) =>
		stmt.bind(
			p.id,
			p.sha,
			p.prNumber,
			p.route,
			p.region,
			p.coldTtfbMs,
			p.warmTtfbMs,
			p.p95TtfbMs,
			p.statusCode,
			p.cfColo,
			p.cfPlacement,
			p.source,
		),
	);

	await db.batch(batch);
}

export interface QueryParams {
	route?: string;
	region?: string;
	source?: "deploy" | "cron";
	since?: string;
	limit?: number;
}

/** Query historical results with optional filters. */
export async function queryResults(db: D1Database, params: QueryParams): Promise<PerfResult[]> {
	const conditions: string[] = [];
	const bindings: (string | number)[] = [];

	if (params.route) {
		conditions.push("route = ?");
		bindings.push(params.route);
	}
	if (params.region) {
		conditions.push("region = ?");
		bindings.push(params.region);
	}
	if (params.source) {
		conditions.push("source = ?");
		bindings.push(params.source);
	}
	if (params.since) {
		conditions.push("timestamp >= ?");
		bindings.push(params.since);
	}

	const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
	const limit = Math.min(params.limit ?? 500, 1000);

	const query = `SELECT * FROM perf_results ${where} ORDER BY timestamp DESC LIMIT ?`;
	bindings.push(limit);

	const result = await db
		.prepare(query)
		.bind(...bindings)
		.all<PerfResult>();
	return result.results;
}

/** Get the latest result per route/region combo. */
export async function getLatestResults(db: D1Database): Promise<PerfResult[]> {
	const result = await db
		.prepare(
			`SELECT p.* FROM perf_results p
			INNER JOIN (
				SELECT route, region, MAX(timestamp) as max_ts
				FROM perf_results
				GROUP BY route, region
			) latest ON p.route = latest.route AND p.region = latest.region AND p.timestamp = latest.max_ts
			ORDER BY p.region, p.route`,
		)
		.all<PerfResult>();
	return result.results;
}

/** Get rolling medians for each route/region over the last N days. */
export async function getRollingMedians(
	db: D1Database,
	days: number = 7,
): Promise<
	Array<{ route: string; region: string; median_cold: number; median_warm: number; count: number }>
> {
	const result = await db
		.prepare(
			`SELECT
				route,
				region,
				COUNT(*) as count,
				-- SQLite doesn't have PERCENTILE_CONT, so we approximate with AVG of middle values
				AVG(cold_ttfb_ms) as median_cold,
				AVG(warm_ttfb_ms) as median_warm
			FROM perf_results
			WHERE timestamp >= datetime('now', ?)
				AND cold_ttfb_ms IS NOT NULL
			GROUP BY route, region
			ORDER BY region, route`,
		)
		.bind(`-${days} days`)
		.all<{
			route: string;
			region: string;
			median_cold: number;
			median_warm: number;
			count: number;
		}>();
	return result.results;
}

/**
 * Get all deploy-triggered results (with SHA and PR info) for chart markers.
 * Only 'deploy' source has SHA attribution -- 'cron' is untagged baseline.
 */
export async function getDeployResults(db: D1Database, since?: string): Promise<PerfResult[]> {
	const sinceClause = since ? "AND timestamp >= ?" : "";
	const bindings: string[] = [];
	if (since) bindings.push(since);

	const result = await db
		.prepare(
			`SELECT * FROM perf_results
			WHERE source = 'deploy' ${sinceClause}
			ORDER BY timestamp ASC`,
		)
		.bind(...bindings)
		.all<PerfResult>();
	return result.results;
}

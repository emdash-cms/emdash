/** D1 storage layer for perf results. */

/** All valid values for the `source` column. */
export type Source = "deploy" | "cron" | "manual";

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
	/** Raw JSON string as stored. Use {@link parseColdServerTimings} to decode. */
	cold_server_timings: string | null;
	/**
	 * Median duration per metric across warm requests, same JSON shape as
	 * `cold_server_timings`. Null when the target didn't emit Server-Timing
	 * on warm responses, or when no warm requests were issued.
	 */
	warm_server_timings: string | null;
	note: string | null;
	timestamp: string;
	source: string;
	site: string;
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
	/** Will be JSON.stringify'd on the way in. Null if unavailable. */
	coldServerTimings: Record<string, { dur: number; desc?: string }> | null;
	/** Median-per-metric snapshot of warm Server-Timing. Null if unavailable. */
	warmServerTimings: Record<string, { dur: number; desc?: string }> | null;
	note: string | null;
	source: Source;
	site: string;
}

/** Column list shared between insertResult and insertResults. */
const INSERT_COLUMNS =
	"id, sha, pr_number, route, region, cold_ttfb_ms, warm_ttfb_ms, p95_ttfb_ms, status_code, cf_colo, cf_placement, cold_server_timings, warm_server_timings, note, source, site";
const INSERT_PLACEHOLDERS = "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?";

function bindInsert(stmt: D1PreparedStatement, p: InsertParams): D1PreparedStatement {
	return stmt.bind(
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
		p.coldServerTimings ? JSON.stringify(p.coldServerTimings) : null,
		p.warmServerTimings ? JSON.stringify(p.warmServerTimings) : null,
		p.note,
		p.source,
		p.site,
	);
}

/** Insert a single measurement result. */
export async function insertResult(db: D1Database, params: InsertParams): Promise<void> {
	await bindInsert(
		db.prepare(`INSERT INTO perf_results (${INSERT_COLUMNS}) VALUES (${INSERT_PLACEHOLDERS})`),
		params,
	).run();
}

/** Insert a batch of results in a single transaction. */
export async function insertResults(db: D1Database, results: InsertParams[]): Promise<void> {
	const stmt = db.prepare(
		`INSERT INTO perf_results (${INSERT_COLUMNS}) VALUES (${INSERT_PLACEHOLDERS})`,
	);
	await db.batch(results.map((p) => bindInsert(stmt, p)));
}

export interface QueryParams {
	route?: string;
	region?: string;
	source?: Source;
	site?: string;
	since?: string;
	limit?: number;
}

/**
 * Normalize an ISO-8601 timestamp (e.g. "2026-04-20T05:00:00.000Z") to the
 * " "-separated form D1's `datetime('now')` writes ("2026-04-20 05:00:00").
 *
 * SQLite compares TEXT lexicographically: space (0x20) sorts before "T"
 * (0x54). If we pass the client's ISO string straight into `timestamp >= ?`,
 * any stored row whose calendar date matches the since-boundary compares
 * LESS than since regardless of its actual time, so same-day filters (1h,
 * and the "today" portion of 24h) silently return zero rows.
 */
function normalizeSince(since: string): string {
	const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(since);
	return match ? `${match[1]} ${match[2]}` : since;
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
	if (params.site) {
		conditions.push("site = ?");
		bindings.push(params.site);
	}
	if (params.since) {
		conditions.push("timestamp >= ?");
		bindings.push(normalizeSince(params.since));
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

/**
 * Get the latest result per route/region combo for a given site.
 * Manual runs are excluded -- they're ad-hoc probes and would otherwise
 * poison the dashboard's "current state" cards whenever one was the most
 * recent sample.
 */
export async function getLatestResults(db: D1Database, site: string): Promise<PerfResult[]> {
	const result = await db
		.prepare(
			`SELECT p.* FROM perf_results p
			INNER JOIN (
				SELECT route, region, MAX(timestamp) as max_ts
				FROM perf_results
				WHERE source != 'manual' AND site = ?
				GROUP BY route, region
			) latest ON p.route = latest.route AND p.region = latest.region AND p.timestamp = latest.max_ts
			WHERE p.source != 'manual' AND p.site = ?
			ORDER BY p.region, p.route`,
		)
		.bind(site, site)
		.all<PerfResult>();
	return result.results;
}

/**
 * Get rolling medians for each route/region over the last N days for a given site.
 * Manual runs are excluded so ad-hoc probes don't pull the baseline around.
 */
export async function getRollingMedians(
	db: D1Database,
	site: string,
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
				AND source != 'manual'
				AND site = ?
			GROUP BY route, region
			ORDER BY region, route`,
		)
		.bind(`-${days} days`, site)
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
export async function getDeployResults(
	db: D1Database,
	site: string,
	since?: string,
): Promise<PerfResult[]> {
	const sinceClause = since ? "AND timestamp >= ?" : "";
	const bindings: string[] = [site];
	if (since) bindings.push(normalizeSince(since));

	const result = await db
		.prepare(
			`SELECT * FROM perf_results
			WHERE source = 'deploy' AND site = ? ${sinceClause}
			ORDER BY timestamp ASC`,
		)
		.bind(...bindings)
		.all<PerfResult>();
	return result.results;
}

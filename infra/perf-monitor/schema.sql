-- Perf monitor D1 schema

CREATE TABLE IF NOT EXISTS perf_results (
  id TEXT PRIMARY KEY,
  sha TEXT,
  pr_number INTEGER,
  route TEXT NOT NULL,
  region TEXT NOT NULL,
  cold_ttfb_ms REAL,
  warm_ttfb_ms REAL,
  p95_ttfb_ms REAL,
  status_code INTEGER,
  cf_colo TEXT,
  cf_placement TEXT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT NOT NULL  -- 'deploy' | 'cron'
);

CREATE INDEX IF NOT EXISTS idx_perf_route_region_ts ON perf_results(route, region, timestamp);
CREATE INDEX IF NOT EXISTS idx_perf_sha ON perf_results(sha);
CREATE INDEX IF NOT EXISTS idx_perf_pr ON perf_results(pr_number);
CREATE INDEX IF NOT EXISTS idx_perf_source_ts ON perf_results(source, timestamp);
CREATE INDEX IF NOT EXISTS idx_perf_timestamp ON perf_results(timestamp);

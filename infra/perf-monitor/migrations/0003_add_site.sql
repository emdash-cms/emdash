-- Tag each measurement with the demo site it came from. Existing rows all
-- belong to the baseline blog-demo; the cache-demo site was added later.

ALTER TABLE perf_results ADD COLUMN site TEXT NOT NULL DEFAULT 'blog';

CREATE INDEX IF NOT EXISTS idx_perf_site_ts ON perf_results(site, timestamp);
CREATE INDEX IF NOT EXISTS idx_perf_site_route_region_ts ON perf_results(site, route, region, timestamp);

/** Target routes to measure and their thresholds. */

export interface TargetRoute {
	path: string;
	label: string;
	/** Cold TTFB threshold in ms -- CI fails if exceeded. */
	coldThresholdMs: number;
	/**
	 * HTTP status codes considered valid for this route. If a measurement returns
	 * something outside this set, the CI trigger marks it as a sanity-check failure.
	 * Measuring a 404 or 500 response tells us nothing about real-world perf -- the
	 * route is either broken or has drifted (e.g. a referenced post was deleted).
	 *
	 * Note: the probe follows redirects, so this describes the final response status.
	 * `/_emdash/admin` 302s to the login page (200), so 200 covers it.
	 */
	expectedStatuses: number[];
}

export const TARGET_URL = "https://blog-demo.emdashcms.com";

/**
 * The name of the Worker that serves the demo site. Queue consumer filters
 * deploy events by this name -- other Worker builds on the account are ignored.
 * If blog-demo is renamed, update this.
 */
export const DEMO_WORKER_NAME = "emdash-demo-blog";

/**
 * GitHub repo used for PR number lookup. SHA -> merged PR resolution happens
 * via the GitHub API when a deploy event arrives.
 */
export const GITHUB_REPO = "emdash-cms/emdash";

/**
 * Routes we measure. Each exercises a different code path on the demo:
 * - "/" hits the homepage template and queries the latest posts
 * - "/posts/<slug>" renders a single post (different template + single-row fetch)
 * - "/_emdash/admin" returns a redirect from the admin root -- measures auth middleware latency
 *
 * We avoid `/_emdash/api/content/*` -- it requires auth and returns 401 immediately,
 * which doesn't reflect real query latency.
 */
export const TARGET_ROUTES: TargetRoute[] = [
	{
		path: "/",
		label: "Homepage",
		coldThresholdMs: 2000,
		expectedStatuses: [200],
	},
	{
		path: "/posts/marshland-birds-at-the-lake-havasu-national-wildlife-refuge",
		label: "Single Post",
		coldThresholdMs: 2000,
		expectedStatuses: [200],
	},
	{
		path: "/_emdash/admin",
		label: "Admin (login page)",
		coldThresholdMs: 1500,
		expectedStatuses: [200],
	},
];

export const REGIONS = ["use", "euw", "ape", "aps"] as const;
export type Region = (typeof REGIONS)[number];

export const REGION_LABELS: Record<Region, string> = {
	use: "US East",
	euw: "Europe West",
	ape: "Asia Pacific East",
	aps: "Asia Pacific South",
};

/** Number of warm requests per route (we take the median). */
export const WARM_REQUESTS = 5;

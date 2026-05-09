/**
 * Protocol-level constants. These are part of the aggregator's contract with
 * the EmDash plugin lexicons, not per-deployment configuration — they don't
 * vary across staging, prod, or self-hosted instances. Per-environment
 * tunables (Jetstream URL, Constellation URL) live in wrangler.jsonc `vars`.
 */

/**
 * NSIDs the aggregator subscribes to via Jetstream and verifies via PDS
 * fetches. Will migrate to FAIR-namespaced equivalents once those NSIDs
 * stabilise.
 */
export const WANTED_COLLECTIONS = [
	"com.emdashcms.experimental.package.profile",
	"com.emdashcms.experimental.package.release",
] as const;

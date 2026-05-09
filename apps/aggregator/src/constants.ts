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
 *
 * Two record families:
 *   - `package.*` — per-package metadata (profile + immutable releases) backing
 *     the discovery / install path.
 *   - `publisher.*` — identity-level metadata about the publishing entity
 *     (`publisher.profile`, rkey `self`) and verification claims about it
 *     (`publisher.verification`, rkey TID). Verifications are bound to the
 *     subject's handle + publisher.profile.displayName at issuance time;
 *     the consumer stores facts as observed and clients re-check validity at
 *     read time.
 */
export const WANTED_COLLECTIONS = [
	"com.emdashcms.experimental.package.profile",
	"com.emdashcms.experimental.package.release",
	"com.emdashcms.experimental.publisher.profile",
	"com.emdashcms.experimental.publisher.verification",
] as const;

/**
 * Public types for the experimental plugin registry.
 *
 * Kept in their own module so they don't get re-bundled into the
 * `astro/integration/runtime.ts` chunk's dist output. tsdown / rolldown
 * are sensitive to which top-level types live alongside `definePlugin`'s
 * overloads, and pulling these types into the integration module
 * affected downstream `definePlugin()` overload resolution for trusted
 * plugins built against core's dist (see commit history for the
 * detailed write-up).
 */

/**
 * Experimental plugin registry configuration.
 *
 * See {@link ExperimentalConfig.registry}.
 */
export interface RegistryConfig {
	/**
	 * Base URL of the registry aggregator (an atproto AppView that indexes
	 * the firehose for `pm.fair.package.*` and `com.emdashcms.*` records).
	 *
	 * Must be the origin where the aggregator's XRPC endpoints are mounted,
	 * such that `${aggregatorUrl}/xrpc/<nsid>` resolves to a valid endpoint.
	 *
	 * Must be HTTPS in production; `http://localhost` or `http://127.0.0.1`
	 * are accepted in dev.
	 */
	aggregatorUrl: string;

	/**
	 * Optional comma-separated list of labeller DIDs forwarded as the
	 * `atproto-accept-labelers` header on every aggregator request.
	 *
	 * Format follows the atproto convention:
	 * `did:plc:abc;redact, did:plc:def`
	 *
	 * When unset, the aggregator applies its operator-default labeller set
	 * (typically the EmDash publisher-verification labeller and any
	 * additional trusted labellers the aggregator operator configured).
	 */
	acceptLabelers?: string;

	/**
	 * Site-level policy applied to the latest-release selection filter.
	 *
	 * These filters operate over the signed records the aggregator returns;
	 * they are not protocol-level constraints. See the RFC's
	 * "Update Discovery and Takedowns" section for the integration point.
	 */
	policy?: {
		/**
		 * Hold back releases newer than this when computing the recommended
		 * install or update version. Mitigates "compromised publisher
		 * account pushes a malicious release of an established plugin" by
		 * giving the takedown labeller a detection window.
		 *
		 * Accepts a duration string (`"24h"`, `"48h"`, `"72h"`, `"7d"`) or a
		 * number of seconds.
		 *
		 * Currently applies uniformly to all releases. A future addition
		 * may exempt brand-new packages (those with no prior release
		 * history) so the holdback doesn't block first-time publishing,
		 * but that exemption is not implemented yet; use
		 * {@link minimumReleaseAgeExclude} to allowlist trusted publishers
		 * whose packages should install immediately.
		 *
		 * Defaults to `undefined` (no holdback). A future trust/moderation
		 * RFC will specify the recommended default.
		 */
		minimumReleaseAge?: string | number;

		/**
		 * Packages exempt from the {@link minimumReleaseAge} holdback. Use
		 * for publishers whose release tempo you've explicitly accepted --
		 * your own first-party plugins, a trusted partner, etc.
		 *
		 * Each entry is either:
		 *   - A bare publisher DID (e.g. `"did:plc:abc123"`) -- every
		 *     package from that publisher is exempt.
		 *   - A `<did>/<slug>` pair (e.g.
		 *     `"did:plc:abc123/hotfix-plugin"`) -- only that specific
		 *     package is exempt.
		 *
		 * Whole-publisher exemptions are the common case: trust is
		 * naturally a property of the publisher, not of each individual
		 * package. Per-package exemptions exist for cases where a publisher
		 * has one plugin you want fast-track installs for and others you'd
		 * rather hold back.
		 *
		 * Only DIDs are accepted -- not handles. Handles are mutable
		 * aggregator-supplied envelope data, and accepting them as a
		 * trust input would let a compromised aggregator bypass the
		 * holdback by claiming any handle for any package. DIDs are
		 * tied to the AT URI of the package record itself, so even a
		 * compromised aggregator cannot lie about which DID published
		 * a release.
		 *
		 * Mirrors pnpm's `minimumReleaseAgeExclude`.
		 *
		 * @example
		 * ```ts
		 * minimumReleaseAgeExclude: [
		 *   "did:plc:emdashfirstparty",     // every package from this publisher
		 *   "did:plc:abc123/hotfix-plugin", // just this one package
		 * ]
		 * ```
		 */
		minimumReleaseAgeExclude?: readonly string[];
	};
}

/**
 * Shorthand: pass a bare aggregator URL string in place of a full
 * `RegistryConfig` object when you don't need `acceptLabelers` or
 * `policy`. The normalizer expands the string into
 * `{ aggregatorUrl: <string> }` before any downstream code sees it.
 *
 * @example
 * ```ts
 * experimental: {
 *   registry: "https://registry.emdashcms.com",
 * }
 * ```
 *
 * Equivalent to:
 * ```ts
 * experimental: {
 *   registry: { aggregatorUrl: "https://registry.emdashcms.com" },
 * }
 * ```
 */
export type RegistryConfigInput = string | RegistryConfig;

/**
 * Experimental EmDash features. See `EmDashConfig.experimental`.
 *
 * Each field is independently opt-in. Fields may be promoted out of
 * `experimental` (becoming top-level `EmDashConfig` options) or removed
 * in minor releases; check the changelog when upgrading.
 */
export interface ExperimentalConfig {
	/**
	 * Decentralized plugin registry.
	 *
	 * When set, replaces the centralized `marketplace` for the admin UI's
	 * browse and install flows. The registry is an atproto-backed
	 * federation: package metadata lives in each publisher's PDS and
	 * an aggregator (the `aggregatorUrl`) indexes the firehose and
	 * exposes read-only XRPC endpoints for discovery.
	 *
	 * See [RFC 0001](https://github.com/emdash-cms/emdash/pull/694) for
	 * the protocol design.
	 *
	 * **Trust model (v1, experimental).** Today EmDash trusts the
	 * configured aggregator with these claims, per package and per
	 * release:
	 *
	 *   - The publisher DID associated with a `(did, slug)` pair.
	 *   - The artifact `url`, the artifact `checksum`, and any mirror
	 *     URLs returned for a release.
	 *   - The published handle for a DID (used for display only;
	 *     EmDash separately verifies the DID->handle round-trip in the
	 *     admin UI before treating a handle as confirmed).
	 *
	 * What EmDash verifies independently before activating an
	 * installed plugin:
	 *
	 *   - The artifact bytes hash to the checksum the aggregator
	 *     returned (so a malicious mirror or in-transit tamper can't
	 *     swap the bundle).
	 *   - The bundle's `manifest.id` matches the requested slug, and
	 *     its `manifest.version` matches the release version (so an
	 *     attacker who controls the aggregator can't trick the
	 *     sandbox into addressing the wrong plugin id).
	 *   - The bundle's `manifest.capabilities` matches what the admin
	 *     acknowledged in the consent dialog (so a publisher can't
	 *     ship a bundle that requests more permissions than the
	 *     dialog displayed).
	 *
	 * What's NOT yet verified:
	 *
	 *   - Full MST proof / publisher signature on the release record.
	 *     A compromised aggregator can forge a release for any DID
	 *     and slug, and the install will succeed as long as the
	 *     bundle matches the (forged) checksum.
	 *   - Per-release replay / rollback: the aggregator chooses which
	 *     release version is "latest".
	 *
	 * **Recommendation.** Until full signature verification lands,
	 * point `aggregatorUrl` only at an aggregator you operate
	 * yourself or one you trust with the same level of authority as
	 * a centralized plugin source. The `policy.minimumReleaseAge` and
	 * `acceptLabelers` knobs partially mitigate by widening the
	 * detection window for takedowns, but they assume the labeller
	 * system is operating.
	 *
	 * Requires `sandboxRunner` to be configured -- registry plugins
	 * always run sandboxed.
	 *
	 * Accepts a bare URL string as shorthand for
	 * `{ aggregatorUrl: "..." }`. Use the full object form when you
	 * need `acceptLabelers` or `policy`.
	 */
	registry?: RegistryConfigInput;
}

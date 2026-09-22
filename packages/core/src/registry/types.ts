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
	 * Optional comma-separated list of bare labeller DIDs forwarded as the
	 * `atproto-accept-labelers` header on every aggregator request. The
	 * declaration contributes to the client's cache identity.
	 *
	 * The aggregator validates the declaration and rejects unknown sources or
	 * a list that omits a required source. It does not let the declaration
	 * override its configured approval, block, takedown, or withdrawal policy.
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
		 * A package's first release is exempt only when the aggregator
		 * reports one release and confirms that its retained history is
		 * complete. Missing or incomplete history keeps the holdback in
		 * force. Use {@link minimumReleaseAgeExclude} to allowlist trusted
		 * publishers whose packages should always install immediately.
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
 * registry: "https://registry.emdashcms.com"
 * ```
 *
 * Equivalent to:
 * ```ts
 * registry: { aggregatorUrl: "https://registry.emdashcms.com" }
 * ```
 */
export type RegistryConfigInput = string | RegistryConfig;

export type RegistryConfigOption = RegistryConfigInput | false;

/**
 * Experimental EmDash features. See `EmDashConfig.experimental`.
 *
 * Each field is independently opt-in. Fields may be promoted out of
 * `experimental` (becoming top-level `EmDashConfig` options) or removed
 * in minor releases; check the changelog when upgrading.
 */
export interface ExperimentalConfig {
	/**
	 * Deprecated location for registry configuration. Use the top-level
	 * `registry` option instead. A top-level value takes precedence.
	 *
	 * @deprecated Use `EmDashConfig.registry`.
	 */
	registry?: RegistryConfigInput;
}

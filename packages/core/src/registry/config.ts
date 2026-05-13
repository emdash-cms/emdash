/**
 * Helpers for normalizing the experimental registry integration option
 * (`config.experimental.registry` in `astro.config.mjs`) into the shape
 * exposed on the admin manifest.
 *
 * The integration option accepts a human-friendly duration string for
 * `policy.minimumReleaseAge` (`"48h"`, `"7d"`); the manifest exposes
 * seconds so the browser doesn't need a duration parser.
 */

import type { RegistryConfig, RegistryConfigInput } from "./types.js";

/**
 * Shape returned in the admin manifest's `registry` field. The browser
 * consumes this directly -- all duration normalization and aggregator URL
 * validation has already happened by the time it gets here.
 */
export interface ManifestRegistryConfig {
	aggregatorUrl: string;
	acceptLabelers?: string;
	policy?: {
		minimumReleaseAgeSeconds?: number;
		/**
		 * Allowlist of publishers / packages exempt from the
		 * {@link minimumReleaseAgeSeconds} holdback. Each entry is either:
		 *
		 *   - A bare publisher identifier: `"did:plc:abc123"` or a handle
		 *     like `"example.dev"`. Every package from that publisher is
		 *     exempt.
		 *   - A `publisher/slug` pair: only that specific package is exempt.
		 *
		 * Normalized to lowercase strings at config load time so the
		 * browser does case-insensitive comparison. See
		 * {@link releaseExemptFromMinimumAge}.
		 */
		minimumReleaseAgeExclude?: string[];
	};
}

/**
 * Canonicalize a capabilities list for set-style comparison.
 *
 * Capabilities (the legacy declared-access shape used by the current
 * sandbox enforcer) are conceptually a *set*: order, duplicates, and
 * non-string entries don't carry meaning. The install handler's drift
 * check compares the admin's acknowledged set against the bundle
 * manifest's set; both sides pass through this canonicalizer first so
 * an aggregator-supplied array with unstable order or junk entries
 * can't cause a spurious drift rejection.
 *
 * Filters non-strings, deduplicates, and sorts lexically. Named to
 * avoid shadowing `@emdash-cms/plugin-types`'s existing
 * `normalizeCapabilities` (which dedupes + applies the deprecated →
 * current alias map but does not filter junk or sort).
 *
 * Exported so the same shape is produced by the browser before sending
 * the `acknowledgedDeclaredAccess` payload and by the server before
 * comparing against the bundle.
 */
export function canonicalCapabilitiesForDriftCheck(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	for (const entry of value) {
		if (typeof entry === "string" && entry.length > 0) {
			seen.add(entry);
		}
	}
	return [...seen].toSorted();
}

/**
 * Returns whether a `(publisher_did, slug)` pair is on the
 * minimum-release-age exemption list. Exported so the same matcher is
 * used by the browser policy filter and the server-side install
 * enforcement.
 *
 * Matching is DID-only. Handles are aggregator-supplied envelope data
 * (mutable, controlled by an attacker who compromises the aggregator)
 * and cannot be used as a trust input -- a compromised aggregator
 * could claim any handle for any package and bypass the holdback. DIDs
 * are part of the AT URI of the package record and are independently
 * resolvable, so even a compromised aggregator can't lie about the
 * publisher DID without also breaking checksum verification downstream.
 *
 * Entries from config are already lowercased at manifest-build time.
 * Runtime values are lowercased here at compare time.
 */
export function releaseExemptFromMinimumAge(
	exclude: readonly string[] | undefined,
	publisherDid: string,
	slug: string,
): boolean {
	if (!exclude || exclude.length === 0) return false;
	const didLower = publisherDid.toLowerCase();
	const slugLower = slug.toLowerCase();
	const fullDid = `${didLower}/${slugLower}`;

	for (const entry of exclude) {
		if (entry === didLower) return true;
		if (entry === fullDid) return true;
	}
	return false;
}

const DURATION_PATTERN = /^(\d+)(s|m|h|d|w)$/;

/** Trailing slashes on the aggregator URL, stripped during normalization. */
const TRAILING_SLASHES = /\/+$/;

/** Trailing dot on a hostname, stripped before URL host comparisons. */
const TRAILING_DOT = /\.$/;

/**
 * Parse a duration string or raw second count into a non-negative
 * integer count of seconds. Throws on unrecognised input so config
 * mistakes fail at startup rather than silently disabling the policy.
 */
export function parseDurationSeconds(duration: string | number): number {
	if (typeof duration === "number") {
		if (!Number.isFinite(duration) || duration < 0) {
			throw new Error(`Invalid duration: ${duration} (must be a non-negative finite number)`);
		}
		return Math.floor(duration);
	}

	const match = duration.match(DURATION_PATTERN);
	if (!match) {
		throw new Error(
			`Invalid duration format: "${duration}". Use a duration string like "48h", "7d", "30m", or a number of seconds.`,
		);
	}

	const value = parseInt(match[1]!, 10);
	const unit = match[2];

	switch (unit) {
		case "s":
			return value;
		case "m":
			return value * 60;
		case "h":
			return value * 60 * 60;
		case "d":
			return value * 24 * 60 * 60;
		case "w":
			return value * 7 * 24 * 60 * 60;
		default:
			// Unreachable given the regex, but keep the exhaustive arm for
			// future maintainers who add a unit to the pattern.
			throw new Error(`Unknown duration unit: ${unit}`);
	}
}

/**
 * Validate that `aggregatorUrl` is a safe outbound target for the
 * registry's XRPC calls. Same posture as artifact downloads: HTTPS
 * required in production; `http://localhost` allowed only in dev.
 *
 * The aggregator's responses are the trust source for release records,
 * checksums, labels, mirrors, and `indexedAt` (until full MST
 * verification lands). Allowing plain HTTP here would let a network
 * attacker swap a release record and point the artifact URL at their
 * own HTTPS bundle, defeating the checksum trust chain because the
 * attacker controls the unsigned transport that supplied the checksum.
 */
export function validateAggregatorUrl(aggregatorUrl: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(aggregatorUrl);
	} catch {
		throw new Error(`registry.aggregatorUrl is not a valid URL: ${aggregatorUrl}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`registry.aggregatorUrl must use http or https: ${aggregatorUrl}`);
	}
	// Reject embedded credentials. The normalized aggregator URL ends
	// up in the admin manifest and is shipped to every admin browser;
	// browser `fetch()` also outright rejects URLs with `user:pass@`,
	// so leaving them in would both leak the credentials and break the
	// registry UI at runtime.
	if (parsed.username || parsed.password) {
		throw new Error("registry.aggregatorUrl must not contain embedded credentials (user:pass@)");
	}

	// WHATWG URL preserves the brackets on IPv6 hostnames -- strip them
	// before any comparison so `https://[::1]/` is recognised as localhost
	// and not treated as a generic domain string.
	const rawHostname = parsed.hostname.toLowerCase().replace(TRAILING_DOT, "");
	const hostname =
		rawHostname.startsWith("[") && rawHostname.endsWith("]")
			? rawHostname.slice(1, -1)
			: rawHostname;
	const isLocalhost =
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname === "127.0.0.1" ||
		hostname === "::1" ||
		// IPv4-mapped IPv6 forms of loopback, e.g. `::ffff:127.0.0.1` and `::ffff:7f00:1`.
		hostname.startsWith("::ffff:127.") ||
		hostname.startsWith("::ffff:7f00:");

	if (!import.meta.env.DEV) {
		if (parsed.protocol === "http:") {
			throw new Error(`registry.aggregatorUrl must use https in production: ${aggregatorUrl}`);
		}
		if (isLocalhost) {
			throw new Error(
				`registry.aggregatorUrl points at localhost; allowed only in dev: ${aggregatorUrl}`,
			);
		}
	} else if (parsed.protocol === "http:" && !isLocalhost) {
		throw new Error(
			`registry.aggregatorUrl must use https (http allowed only for localhost in dev): ${aggregatorUrl}`,
		);
	}

	return parsed;
}

/**
 * Expand the `RegistryConfigInput` shorthand into the full
 * `RegistryConfig` object shape.
 *
 * Users can pass a bare aggregator URL string for the common case
 * (`experimental.registry: "https://registry.emdashcms.com"`); the
 * normalizer handles either form transparently.
 *
 * Returns `undefined` for `undefined` input so callers can chain with
 * optional chaining.
 */
export function coerceRegistryConfig(
	input: RegistryConfigInput | undefined,
): RegistryConfig | undefined {
	if (input === undefined) return undefined;
	if (typeof input === "string") return { aggregatorUrl: input };
	return input;
}

/**
 * Normalize the user-supplied `RegistryConfigInput` into the shape that
 * ships to the admin browser via the manifest endpoint.
 *
 * Accepts either the shorthand string form
 * (`"https://registry.emdashcms.com"`) or the full `RegistryConfig`
 * object. Returns `null` when `input` is undefined so callers can
 * spread the result directly into the manifest object.
 *
 * Throws if the aggregator URL is malformed, points at a forbidden host,
 * or `policy.minimumReleaseAge` is unparseable. These surface at
 * runtime startup as 500s from the manifest endpoint -- intended,
 * because the alternative is silently disabling the registry on
 * misconfigured sites.
 *
 * TODO: switch to a Zod schema for richer per-field error messages and
 * to surface misconfigurations to the admin UI as a banner instead of
 * a manifest 500.
 */
export function normalizeRegistryConfig(
	input: RegistryConfigInput | undefined,
): ManifestRegistryConfig | null {
	const config = coerceRegistryConfig(input);
	if (!config) return null;

	const aggregatorUrl = config.aggregatorUrl?.trim();
	if (!aggregatorUrl) {
		throw new Error("registry.aggregatorUrl is required when registry is configured");
	}

	validateAggregatorUrl(aggregatorUrl);

	const out: ManifestRegistryConfig = {
		// Strip any trailing slash so `${aggregatorUrl}/xrpc/...` works
		// regardless of how the user wrote it.
		aggregatorUrl: aggregatorUrl.replace(TRAILING_SLASHES, ""),
	};

	if (config.acceptLabelers) {
		out.acceptLabelers = config.acceptLabelers;
	}

	const policy: ManifestRegistryConfig["policy"] = {};
	let hasPolicy = false;

	if (config.policy?.minimumReleaseAge !== undefined) {
		policy.minimumReleaseAgeSeconds = parseDurationSeconds(config.policy.minimumReleaseAge);
		hasPolicy = true;
	}

	if (config.policy?.minimumReleaseAgeExclude !== undefined) {
		// Normalize at load time so callers (browser and server) can do
		// plain string compares without each one re-implementing the
		// case-folding rule.
		const list = config.policy.minimumReleaseAgeExclude.map((entry) => {
			const trimmed = entry.trim();
			if (!trimmed) {
				throw new Error("registry.policy.minimumReleaseAgeExclude entries cannot be empty");
			}
			return trimmed.toLowerCase();
		});
		if (list.length > 0) {
			policy.minimumReleaseAgeExclude = list;
			hasPolicy = true;
		}
	}

	if (hasPolicy) {
		out.policy = policy;
	}

	return out;
}

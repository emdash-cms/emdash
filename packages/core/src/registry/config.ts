/**
 * Helpers for normalizing the experimental registry integration option
 * (`config.experimental.registry` in `astro.config.mjs`) into the shape
 * exposed on the admin manifest.
 *
 * The integration option accepts a human-friendly duration string for
 * `policy.minimumReleaseAge` (`"48h"`, `"7d"`); the manifest exposes
 * seconds so the browser doesn't need a duration parser.
 */

import { isDid } from "@atcute/lexicons/syntax";

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
		 *   - A bare publisher DID: `"did:plc:abc123"`. Every package from
		 *     that publisher is exempt.
		 *   - A `<did>/<slug>` pair: only that specific package is exempt.
		 *
		 * Handles are not accepted because they are mutable
		 * aggregator-supplied envelope data.
		 *
		 * Normalized to lowercase strings at config load time so the
		 * browser does case-insensitive comparison. See
		 * {@link releaseExemptFromMinimumAge}.
		 */
		minimumReleaseAgeExclude?: string[];
	};
}

export type RegistryConfigurationErrorCode =
	| "REGISTRY_AGGREGATOR_URL_REQUIRED"
	| "REGISTRY_AGGREGATOR_URL_INVALID"
	| "REGISTRY_AGGREGATOR_URL_FORBIDDEN"
	| "REGISTRY_MINIMUM_RELEASE_AGE_INVALID"
	| "REGISTRY_MINIMUM_RELEASE_AGE_EXCLUDE_INVALID";

export type RegistryConfigurationField =
	| "experimental.registry.aggregatorUrl"
	| "experimental.registry.policy.minimumReleaseAge"
	| "experimental.registry.policy.minimumReleaseAgeExclude";

export interface ManifestRegistryConfigurationError {
	code: RegistryConfigurationErrorCode;
	field: RegistryConfigurationField;
}

class RegistryConfigurationError extends Error {
	constructor(
		public readonly code: RegistryConfigurationErrorCode,
		public readonly field: RegistryConfigurationField,
		message: string,
		options?: ErrorOptions,
	) {
		super(`EmDash registry configuration error in ${field}: ${message}`, options);
		this.name = "RegistryConfigurationError";
	}
}

interface RegistryConfigurationValidationOptions {
	allowLocalhost?: boolean;
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

const REGISTRY_PACKAGE_SLUG_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

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

	const value = parseInt(match[1], 10);
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
 * checksums, labels, artifact cache descriptors, and `indexedAt` (until full MST
 * verification lands). Allowing plain HTTP here would let a network
 * attacker swap a release record and point the artifact URL at their
 * own HTTPS bundle, defeating the checksum trust chain because the
 * attacker controls the unsigned transport that supplied the checksum.
 */
export function validateAggregatorUrl(
	aggregatorUrl: string,
	options: RegistryConfigurationValidationOptions = {},
): URL {
	let parsed: URL;
	try {
		parsed = new URL(aggregatorUrl);
	} catch (cause) {
		throw new RegistryConfigurationError(
			"REGISTRY_AGGREGATOR_URL_INVALID",
			"experimental.registry.aggregatorUrl",
			"must be a valid URL",
			{ cause },
		);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new RegistryConfigurationError(
			"REGISTRY_AGGREGATOR_URL_FORBIDDEN",
			"experimental.registry.aggregatorUrl",
			"must use HTTP or HTTPS",
		);
	}
	// Reject embedded credentials. The normalized aggregator URL ends
	// up in the admin manifest and is shipped to every admin browser;
	// browser `fetch()` also outright rejects URLs with `user:pass@`,
	// so leaving them in would both leak the credentials and break the
	// registry UI at runtime.
	if (parsed.username || parsed.password) {
		throw new RegistryConfigurationError(
			"REGISTRY_AGGREGATOR_URL_FORBIDDEN",
			"experimental.registry.aggregatorUrl",
			"must not contain embedded credentials",
		);
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

	const allowLocalhost = options.allowLocalhost ?? import.meta.env.DEV;
	if (!allowLocalhost) {
		if (parsed.protocol === "http:") {
			throw new RegistryConfigurationError(
				"REGISTRY_AGGREGATOR_URL_FORBIDDEN",
				"experimental.registry.aggregatorUrl",
				"must use HTTPS outside development",
			);
		}
		if (isLocalhost) {
			throw new RegistryConfigurationError(
				"REGISTRY_AGGREGATOR_URL_FORBIDDEN",
				"experimental.registry.aggregatorUrl",
				"must not point at localhost outside development",
			);
		}
	} else if (parsed.protocol === "http:" && !isLocalhost) {
		throw new RegistryConfigurationError(
			"REGISTRY_AGGREGATOR_URL_FORBIDDEN",
			"experimental.registry.aggregatorUrl",
			"must use HTTPS unless it points at localhost in development",
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
 * Throws a field-specific configuration error if the aggregator URL is
 * malformed or forbidden, or a registry policy value cannot be normalized.
 * The Astro integration uses this to fail during config loading. Runtime
 * manifest generation uses {@link resolveManifestRegistryConfig} to expose
 * recognized failures without exposing the configured value.
 */
export function normalizeRegistryConfig(
	input: RegistryConfigInput | undefined,
	options: RegistryConfigurationValidationOptions = {},
): ManifestRegistryConfig | null {
	const config = coerceRegistryConfig(input);
	if (!config) return null;

	const aggregatorUrl =
		typeof config.aggregatorUrl === "string" ? config.aggregatorUrl.trim() : undefined;
	if (!aggregatorUrl) {
		throw new RegistryConfigurationError(
			"REGISTRY_AGGREGATOR_URL_REQUIRED",
			"experimental.registry.aggregatorUrl",
			"is required when the registry is configured",
		);
	}

	validateAggregatorUrl(aggregatorUrl, options);

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
		try {
			policy.minimumReleaseAgeSeconds = parseDurationSeconds(config.policy.minimumReleaseAge);
		} catch (cause) {
			throw new RegistryConfigurationError(
				"REGISTRY_MINIMUM_RELEASE_AGE_INVALID",
				"experimental.registry.policy.minimumReleaseAge",
				'must be a duration such as "48h", "7d", or a non-negative number of seconds',
				{ cause },
			);
		}
		hasPolicy = true;
	}

	if (config.policy?.minimumReleaseAgeExclude !== undefined) {
		if (!Array.isArray(config.policy.minimumReleaseAgeExclude)) {
			throw new RegistryConfigurationError(
				"REGISTRY_MINIMUM_RELEASE_AGE_EXCLUDE_INVALID",
				"experimental.registry.policy.minimumReleaseAgeExclude",
				"must be an array of DIDs or <did>/<slug> entries",
			);
		}
		// Normalize at load time so callers (browser and server) can do
		// plain string compares without each one re-implementing the
		// case-folding rule.
		const list = config.policy.minimumReleaseAgeExclude.map((entry) => {
			if (typeof entry !== "string") {
				throw new RegistryConfigurationError(
					"REGISTRY_MINIMUM_RELEASE_AGE_EXCLUDE_INVALID",
					"experimental.registry.policy.minimumReleaseAgeExclude",
					"minimumReleaseAgeExclude entry must be a DID or <did>/<slug>",
				);
			}
			const trimmed = entry.trim();
			if (!trimmed) {
				throw new RegistryConfigurationError(
					"REGISTRY_MINIMUM_RELEASE_AGE_EXCLUDE_INVALID",
					"experimental.registry.policy.minimumReleaseAgeExclude",
					"entries cannot be empty",
				);
			}
			const lower = trimmed.toLowerCase();
			const [did, slug, ...extra] = lower.split("/");
			if (
				!did ||
				!isDid(did) ||
				extra.length > 0 ||
				(slug !== undefined && !REGISTRY_PACKAGE_SLUG_PATTERN.test(slug))
			) {
				throw new RegistryConfigurationError(
					"REGISTRY_MINIMUM_RELEASE_AGE_EXCLUDE_INVALID",
					"experimental.registry.policy.minimumReleaseAgeExclude",
					"minimumReleaseAgeExclude entry must be a DID or <did>/<slug>",
				);
			}
			return lower;
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

/** Normalize registry config without allowing a known config error to hide the admin. */
export function resolveManifestRegistryConfig(input: RegistryConfigInput | undefined): {
	registry?: ManifestRegistryConfig;
	error?: ManifestRegistryConfigurationError;
} {
	try {
		const registry = normalizeRegistryConfig(input);
		return registry ? { registry } : {};
	} catch (error) {
		if (!(error instanceof RegistryConfigurationError)) throw error;
		return { error: { code: error.code, field: error.field } };
	}
}

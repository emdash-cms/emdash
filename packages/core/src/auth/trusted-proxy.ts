/**
 * Resolve the list of client-IP headers the operator trusts.
 *
 * Resolution order:
 *   1. `config.trustedProxyHeaders` — explicit opt-in via astro.config.mjs.
 *      An empty array is respected (means "trust nothing, ignore env").
 *   2. `EMDASH_TRUSTED_PROXY_HEADERS` env var — comma-separated header names.
 *   3. `[]` — default, no trusted headers.
 *
 * Operators must only set this when they control the reverse proxy.
 * Untrusted clients can set any header they like; trusting headers from
 * an open network defeats rate limiting.
 *
 * Header names are returned lowercased because HTTP header lookups are
 * case-insensitive.
 */

import type { EmDashConfig } from "../astro/integration/runtime.js";

/**
 * RFC 7230 token — valid characters for an HTTP header name. Invalid names
 * passed to `Headers.get()` throw a TypeError at runtime, which would
 * otherwise surface as a 500 from every auth route.
 */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;

/**
 * Normalise a list of header names the way both the config path and any
 * caller passing a pre-resolved list should do: trim, lowercase, drop
 * empty, drop anything that isn't a valid RFC 7230 token. Invalid names
 * would crash `Headers.get()` at runtime.
 */
export function normalizeTrustedHeaders(names: readonly string[]): string[] {
	return names
		.map((h) => h.trim().toLowerCase())
		.filter((h) => h.length > 0 && HEADER_NAME_PATTERN.test(h));
}

function isValidHeaderName(name: string): boolean {
	return HEADER_NAME_PATTERN.test(name);
}

/** Cache for the env-derived value. `null` means "not yet parsed". */
let _envCache: string[] | null = null;

/** Test-only: clear the env cache so a fresh value is read on next call. */
export function _resetTrustedProxyHeadersCache(): void {
	_envCache = null;
}

function getEnvTrustedHeaders(): string[] {
	if (_envCache !== null) return _envCache;
	let raw: string | undefined;
	try {
		// Prefer process.env so SSR/container deployments can override this
		// value at runtime (Vite/Astro inline import.meta.env at build time,
		// which locks the value into the bundle). Fall back to import.meta.env
		// for bundler-managed environments where process.env isn't populated.
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- import.meta.env shape varies by bundler
		const importMetaEnv = (import.meta as unknown as { env?: Record<string, string | undefined> })
			.env;
		raw =
			(typeof process !== "undefined" ? process.env?.EMDASH_TRUSTED_PROXY_HEADERS : undefined) ||
			importMetaEnv?.EMDASH_TRUSTED_PROXY_HEADERS;
	} catch {
		raw = undefined;
	}
	if (!raw) {
		_envCache = [];
		return _envCache;
	}
	_envCache = raw
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter((s) => s.length > 0 && isValidHeaderName(s));
	return _envCache;
}

/**
 * Return the lowercased list of headers to trust for client-IP resolution.
 *
 * When `config?.trustedProxyHeaders` is explicitly set (even to `[]`), it
 * wins. Otherwise fall through to the env var, then to `[]`.
 */
export function getTrustedProxyHeaders(config: EmDashConfig | null | undefined): string[] {
	if (config && config.trustedProxyHeaders !== undefined) {
		return config.trustedProxyHeaders
			.map((h) => h.trim().toLowerCase())
			.filter((h) => h.length > 0 && isValidHeaderName(h));
	}
	return getEnvTrustedHeaders();
}

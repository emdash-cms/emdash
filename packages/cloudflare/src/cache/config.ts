/**
 * Legacy Cloudflare Cache API route cache provider — CONFIG ENTRY
 *
 * @deprecated Prefer native Workers Caching for new sites:
 *
 * ```ts
 * // wrangler.jsonc
 * { "cache": { "enabled": true } }
 *
 * // astro.config.mjs
 * import { cacheCloudflare } from "@astrojs/cloudflare/cache";
 * export default defineConfig({
 *   cache: { provider: cacheCloudflare() },
 * });
 * ```
 *
 * Native path invalidates with `cache.purge()` from `cloudflare:workers`
 * (no zone ID or Cache Purge API token). See EmDash docs:
 * Deploy to Cloudflare → Workers Cache.
 *
 * This helper is the older stopgap: Cache API storage + zone REST purge
 * (`CF_ZONE_ID` + `CF_CACHE_PURGE_TOKEN`). Kept for existing sites.
 *
 * This module does NOT import cloudflare:workers and is safe to use at
 * config time.
 */

import type { CacheProviderConfig } from "astro";

import type { CloudflareCacheConfig } from "./runtime.js";

export type { CloudflareCacheConfig };

let deprecationWarned = false;

/**
 * Legacy Cloudflare Cache API route cache provider.
 *
 * @deprecated Prefer `cacheCloudflare()` from `@astrojs/cloudflare/cache`
 * with `"cache": { "enabled": true }` in wrangler. That uses native Workers
 * Caching and `cache.purge()` — no zone credentials.
 *
 * This implementation stores responses with the Workers Cache API
 * (`cache.put()` / `cache.match()`) and invalidates globally via the
 * Cloudflare purge-by-tag REST API, which requires a Zone ID and an API
 * token with "Cache Purge" permission (`CF_ZONE_ID` /
 * `CF_CACHE_PURGE_TOKEN` by default).
 *
 * @param config Optional configuration.
 * @returns A {@link CacheProviderConfig} to pass to `cache.provider`.
 *
 * @example Legacy usage (zone REST purge credentials required)
 * ```ts
 * import { defineConfig } from "astro/config";
 * import cloudflare from "@astrojs/cloudflare";
 * import { cloudflareCache } from "@emdash-cms/cloudflare";
 *
 * export default defineConfig({
 *   adapter: cloudflare(),
 *   cache: {
 *     provider: cloudflareCache(),
 *   },
 * });
 * ```
 */
export function cloudflareCache(
	config: CloudflareCacheConfig = {},
): CacheProviderConfig<CloudflareCacheConfig> {
	if (!deprecationWarned) {
		deprecationWarned = true;
		console.warn(
			"[@emdash-cms/cloudflare] cloudflareCache() is deprecated. " +
				'Prefer native Workers Caching: wrangler "cache": { "enabled": true } ' +
				"and cacheCloudflare() from @astrojs/cloudflare/cache " +
				"(purge via cache.purge() — no CF_ZONE_ID / CF_CACHE_PURGE_TOKEN). " +
				"See https://docs.emdashcms.com/deployment/cloudflare#workers-cache",
		);
	}
	return {
		// Resolved by Vite/Astro at build time — points to the runtime module
		entrypoint: "@emdash-cms/cloudflare/cache",
		config,
	};
}

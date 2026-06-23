/**
 * Cloudflare Cache API route cache provider - CONFIG ENTRY
 *
 * This is the config-time helper. Import it in your astro.config.mjs:
 *
 * ```ts
 * import { cloudflareCache } from "@emdash-cms/cloudflare";
 *
 * export default defineConfig({
 *   cache: {
 *     provider: cloudflareCache(),
 *   },
 * });
 * ```
 *
 * This module does NOT import cloudflare:workers and is safe to use at
 * config time.
 */

import type { CacheProviderConfig } from "astro";

import type { CloudflareCacheConfig } from "./runtime.js";

export type { CloudflareCacheConfig };

/**
 * Cloudflare Cache API route cache provider.
 *
 * Uses the Workers Cache API (`cache.put()`/`cache.match()`) to cache
 * rendered route responses at the edge. Invalidation uses the Cloudflare
 * purge-by-tag REST API for global purge across all edge locations.
 *
 * This is a stopgap until CacheW provides native distributed caching
 * for Workers. Worker responses can't go through the CDN cache today,
 * so we use the Cache API directly. The standard `Cache-Tag` header is
 * set on stored responses so the purge-by-tag API can find them.
 *
 * Tag-based invalidation requires a Zone ID and an API token with
 * "Cache Purge" permission. These can be passed directly in the config
 * or read from environment variables at runtime (default: `CF_ZONE_ID`
 * and `CF_CACHE_PURGE_TOKEN`).
 *
 * @param config Optional configuration.
 * @returns A {@link CacheProviderConfig} to pass to `cache.provider`.
 *
 * @example Basic usage (reads zone ID and token from env vars)
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
 *
 * @example With explicit config
 * ```ts
 * cloudflareCache({
 *   cacheName: "my-site",
 *   zoneId: "abc123...",
 *   apiToken: "xyz789...",
 * })
 * ```
 */
export function cloudflareCache(
	config: CloudflareCacheConfig = {},
): CacheProviderConfig<CloudflareCacheConfig> {
	return {
		// Resolved by Vite/Astro at build time — points to the runtime module
		entrypoint: "@emdash-cms/cloudflare/cache",
		config,
	};
}

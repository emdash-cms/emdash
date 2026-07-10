/**
 * Object-cache adapter functions (config time).
 *
 * These run in `astro.config.mjs` and return serializable
 * {@link ObjectCacheDescriptor}s. The backend is instantiated at runtime by
 * loading the descriptor's `entrypoint`.
 *
 * For Cloudflare KV, use `kvCache()` from `@emdash-cms/cloudflare`.
 *
 * @example
 * ```ts
 * // astro.config.mjs (Node / local)
 * import emdash, { memoryCache } from "emdash/astro";
 *
 * export default defineConfig({
 *   integrations: [emdash({ objectCache: memoryCache() })],
 * });
 * ```
 */

import type { ObjectCacheDescriptor, ObjectCacheRuntimeConfig } from "../../object-cache/types.js";

/** Options for {@link memoryCache}. */
export interface MemoryCacheOptions extends ObjectCacheRuntimeConfig {
	/**
	 * Soft cap on the number of cached keys per isolate before FIFO eviction.
	 * @default 1000
	 */
	maxEntries?: number;
}

/**
 * In-isolate memory object cache.
 *
 * Caches query results across requests within a single isolate/process. On
 * Node (one long-lived process) this is a genuine cross-request cache; on
 * multi-isolate platforms (Cloudflare) prefer `kvCache()` so the cache is
 * shared. Useful for local development regardless of target.
 *
 * @example
 * ```ts
 * emdash({ objectCache: memoryCache({ defaultTtl: 600 }) })
 * ```
 */
export function memoryCache(options: MemoryCacheOptions = {}): ObjectCacheDescriptor {
	return {
		entrypoint: "emdash/object-cache/memory",
		config: { ...options },
	};
}

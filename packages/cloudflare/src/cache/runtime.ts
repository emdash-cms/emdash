/**
 * Cloudflare Cache API route cache provider - RUNTIME ENTRY
 *
 * Implements Astro's CacheProvider interface as a runtime provider using the
 * Workers Cache API for storage and the Cloudflare purge-by-tag REST API for
 * global invalidation.
 *
 * This is a temporary solution until CacheW exists. Workers responses can't
 * go through the CDN cache, so we use cache.put()/cache.match() directly.
 * The standard `Cache-Tag` header (set by Astro's default setHeaders) is
 * preserved on cached responses so the purge-by-tag API works globally.
 *
 * We do NOT implement setHeaders() — Astro's defaultSetHeaders correctly
 * emits CDN-Cache-Control and Cache-Tag. Our onRequest() reads those
 * headers from the response that next() returns.
 *
 * Do NOT import this at config time. Use cloudflareCache() from
 * "@emdash-cms/cloudflare" or "@emdash-cms/cloudflare/cache/config" instead.
 */

import type { CacheProviderFactory } from "astro";
import { env, waitUntil } from "cloudflare:workers";

/**
 * Internal headers stored on cached responses for freshness tracking.
 * These are removed before returning to the client.
 */
const STORED_AT_HEADER = "X-EmDash-Stored-At";
const MAX_AGE_HEADER = "X-EmDash-Max-Age";
const SWR_HEADER = "X-EmDash-SWR";

/** Cloudflare purge API base */
const CF_API_BASE = "https://api.cloudflare.com/client/v4";

/** Matches max-age in CDN-Cache-Control */
const MAX_AGE_REGEX = /max-age=(\d+)/;

/** Matches stale-while-revalidate in CDN-Cache-Control */
const SWR_REGEX = /stale-while-revalidate=(\d+)/;

/** Internal headers to strip before returning responses to the client */
const INTERNAL_HEADERS = [STORED_AT_HEADER, MAX_AGE_HEADER, SWR_HEADER];

/** Default D1 bookmark cookie name (from @emdash-cms/cloudflare d1 config) */
const DEFAULT_BOOKMARK_COOKIE = "__ec_d1_bookmark";

export interface CloudflareCacheConfig {
	/**
	 * Name of the Cache API cache to use.
	 * @default "emdash"
	 */
	cacheName?: string;

	/**
	 * D1 bookmark cookie name. Responses whose only Set-Cookie is this
	 * bookmark will have it stripped before caching. Responses with any
	 * other Set-Cookie headers will not be cached.
	 * @default "__ec_d1_bookmark"
	 */
	bookmarkCookie?: string;

	/**
	 * Cloudflare Zone ID. Required for tag-based invalidation.
	 * If not provided, reads from `zoneIdEnvVar` at runtime.
	 */
	zoneId?: string;

	/**
	 * Environment variable name containing the Zone ID.
	 * @default "CF_ZONE_ID"
	 */
	zoneIdEnvVar?: string;

	/**
	 * Cloudflare API token with Cache Purge permission.
	 * If not provided, reads from `apiTokenEnvVar` at runtime.
	 */
	apiToken?: string;

	/**
	 * Environment variable name containing the API token.
	 * @default "CF_CACHE_PURGE_TOKEN"
	 */
	apiTokenEnvVar?: string;
}

/**
 * Parse CDN-Cache-Control header for max-age and stale-while-revalidate.
 */
function parseCdnCacheControl(header: string | null): { maxAge: number; swr: number } {
	let maxAge = 0;
	let swr = 0;
	if (!header) return { maxAge, swr };
	const maxAgeMatch = MAX_AGE_REGEX.exec(header);
	if (maxAgeMatch) maxAge = parseInt(maxAgeMatch[1]!, 10) || 0;
	const swrMatch = SWR_REGEX.exec(header);
	if (swrMatch) swr = parseInt(swrMatch[1]!, 10) || 0;
	return { maxAge, swr };
}

/**
 * Normalize a URL for use as a cache key.
 * Strips common tracking query parameters and sorts the rest.
 */
function normalizeCacheKey(url: URL): string {
	const normalized = new URL(url.toString());

	const trackingParams = [
		"utm_source",
		"utm_medium",
		"utm_campaign",
		"utm_term",
		"utm_content",
		"fbclid",
		"gclid",
		"gbraid",
		"wbraid",
		"dclid",
		"msclkid",
		"twclid",
		"_ga",
		"_gl",
	];
	for (const param of trackingParams) {
		normalized.searchParams.delete(param);
	}
	normalized.searchParams.sort();

	return normalized.toString();
}

/**
 * Read a config value, falling back to an env var.
 */
function resolveEnvValue(explicit: string | undefined, envVarName: string): string | undefined {
	if (explicit) return explicit;
	if (!(envVarName in env)) return undefined;
	const value: unknown = Reflect.get(env, envVarName);
	return typeof value === "string" ? value : undefined;
}

/**
 * Strip internal tracking headers from a response before returning to client.
 */
function stripInternalHeaders(response: Response): void {
	for (const header of INTERNAL_HEADERS) {
		response.headers.delete(header);
	}
}

/**
 * Check whether all Set-Cookie headers on a response are only the D1
 * bookmark cookie. Returns true if we can safely strip them for caching.
 * Returns false if there are non-bookmark cookies (session, auth, etc.)
 * which means the response should NOT be cached.
 */
function hasOnlyBookmarkCookies(response: Response, bookmarkCookie: string): boolean {
	const cookies = response.headers.getSetCookie();
	if (cookies.length === 0) return true;
	return cookies.every((c) => c.startsWith(`${bookmarkCookie}=`));
}

/**
 * Prepare a response for storage in the Cache API.
 * - Adds internal tracking headers (stored-at, max-age, swr)
 * - Strips Set-Cookie (only called when cookies are safe to strip)
 *
 * Returns null if the response has non-bookmark Set-Cookie headers
 * and should not be cached.
 */
function prepareForCache(
	response: Response,
	maxAge: number,
	swr: number,
	bookmarkCookie: string,
): Response | null {
	if (!hasOnlyBookmarkCookies(response, bookmarkCookie)) {
		return null;
	}
	const prepared = new Response(response.body, response);
	prepared.headers.set(STORED_AT_HEADER, String(Date.now()));
	prepared.headers.set(MAX_AGE_HEADER, String(maxAge));
	prepared.headers.set(SWR_HEADER, String(swr));
	prepared.headers.delete("Set-Cookie");
	return prepared;
}

const factory: CacheProviderFactory<CloudflareCacheConfig> = (config) => {
	const cacheName = config?.cacheName ?? "emdash";
	const bookmarkCookie = config?.bookmarkCookie ?? DEFAULT_BOOKMARK_COOKIE;
	const zoneIdEnvVar = config?.zoneIdEnvVar ?? "CF_ZONE_ID";
	const apiTokenEnvVar = config?.apiTokenEnvVar ?? "CF_CACHE_PURGE_TOKEN";

	async function getCache(): Promise<Cache> {
		return caches.open(cacheName);
	}

	return {
		name: "cloudflare-cache-api",

		// No setHeaders() — we use Astro's defaultSetHeaders which correctly
		// emits CDN-Cache-Control and Cache-Tag. Our onRequest() reads those.

		async onRequest(context, next) {
			// Only cache GET requests
			if (context.request.method !== "GET") {
				return next();
			}

			// Skip cache for authenticated users. Their responses may differ
			// (edit toolbar, admin UI, draft content) and must not be served
			// to other visitors. The Astro session cookie indicates a logged-in user.
			const cookieHeader = context.request.headers.get("Cookie") ?? "";
			if (cookieHeader.includes("astro-session=")) {
				return next();
			}

			const cacheKey = normalizeCacheKey(context.url);
			const cache = await getCache();

			const cached = await cache.match(cacheKey);

			if (cached) {
				const storedAt = parseInt(cached.headers.get(STORED_AT_HEADER) ?? "0", 10);
				const maxAge = parseInt(cached.headers.get(MAX_AGE_HEADER) ?? "0", 10);
				const swr = parseInt(cached.headers.get(SWR_HEADER) ?? "0", 10);
				const ageSeconds = (Date.now() - storedAt) / 1000;

				if (ageSeconds < maxAge) {
					// Fresh — serve from cache
					const hit = new Response(cached.body, cached);
					hit.headers.set("X-Astro-Cache", "HIT");
					stripInternalHeaders(hit);
					return hit;
				}

				if (swr > 0 && ageSeconds < maxAge + swr) {
					// Stale but within SWR window — serve stale, revalidate in background
					const stale = new Response(cached.body, cached);
					stale.headers.set("X-Astro-Cache", "STALE");
					stripInternalHeaders(stale);

					waitUntil(
						(async () => {
							try {
								const fresh = await next();
								const cdnCC = fresh.headers.get("CDN-Cache-Control");
								const parsed = parseCdnCacheControl(cdnCC);
								if (parsed.maxAge > 0 && fresh.ok) {
									const toStore = prepareForCache(fresh, parsed.maxAge, parsed.swr, bookmarkCookie);
									if (toStore) {
										await cache.put(cacheKey, toStore);
									}
								}
							} catch {
								// Non-fatal — next request will retry
							}
						})(),
					);

					return stale;
				}

				// Expired and past SWR window — delete and fall through
				await cache.delete(cacheKey);
			}

			// Cache MISS — render
			const response = await next();

			// Read cache directives from CDN-Cache-Control (set by Astro's defaultSetHeaders)
			const cdnCC = response.headers.get("CDN-Cache-Control");
			const { maxAge, swr } = parseCdnCacheControl(cdnCC);

			if (maxAge > 0 && response.ok) {
				const toStore = prepareForCache(response.clone(), maxAge, swr, bookmarkCookie);
				if (toStore) {
					await cache.put(cacheKey, toStore);
				}

				const miss = new Response(response.body, response);
				miss.headers.set("X-Astro-Cache", "MISS");
				return miss;
			}

			// No cache directives — pass through without caching
			return response;
		},

		async invalidate(options) {
			if (options.tags) {
				const zoneId = resolveEnvValue(config?.zoneId, zoneIdEnvVar);
				const apiToken = resolveEnvValue(config?.apiToken, apiTokenEnvVar);

				if (!zoneId || !apiToken) {
					console.warn(
						`[cloudflare-cache-api] Tag-based invalidation skipped: missing Zone ID or API token. ` +
							`Set the ${zoneIdEnvVar} and ${apiTokenEnvVar} environment variables, ` +
							`or pass zoneId/apiToken in the cloudflareCache() config.`,
					);
					return;
				}

				const tags = Array.isArray(options.tags) ? options.tags : [options.tags];

				const response = await fetch(`${CF_API_BASE}/zones/${zoneId}/purge_cache`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ tags }),
				});

				if (!response.ok) {
					const body = await response.text().catch(() => "");
					throw new Error(
						`[cloudflare-cache-api] Cache purge failed (${response.status}): ${body}`,
					);
				}
			}

			if (options.path) {
				const cache = await getCache();
				await cache.delete(options.path);
			}
		},
	};
};

export default factory;

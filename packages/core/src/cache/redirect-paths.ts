/**
 * Cache invalidation specs for redirect source paths.
 *
 * The Cloudflare adapter tags cached pages by request pathname
 * (`astro-path:<pathname>`). When a redirect is written, purging the source
 * path (and its trailing-slash variant) clears any stale cached page at that
 * location so the redirect middleware runs on the next request.
 */

export interface CachePathSpec {
	path: string;
}

interface CacheLike {
	enabled?: boolean;
	invalidate(spec: CachePathSpec): Promise<unknown>;
}

function toggledTrailingSlash(path: string): string | null {
	if (path.length <= 1) return null;
	return path.endsWith("/") ? path.slice(0, -1) : `${path}/`;
}

/**
 * Build cache-invalidation specs for one or more redirect source paths.
 * Returns each path with and without a trailing slash, deduplicated.
 */
export function redirectSourceCachePaths(...sources: string[]): CachePathSpec[] {
	const paths = new Set<string>();
	for (const source of sources) {
		if (!source) continue;
		paths.add(source);
		const alt = toggledTrailingSlash(source);
		if (alt) paths.add(alt);
	}
	return Array.from(paths, (path) => ({ path }));
}

/**
 * Invalidate the edge cache for one or more redirect source paths.
 * Failures are logged but not thrown: the redirect mutation has already
 * been committed and should still return a successful response.
 */
export async function invalidateRedirectSourcePaths(
	cache: CacheLike | undefined,
	...sources: string[]
): Promise<void> {
	if (!cache?.enabled) return;
	for (const spec of redirectSourceCachePaths(...sources)) {
		try {
			await cache.invalidate(spec);
		} catch (error) {
			console.error(`[redirects] Failed to invalidate cache for ${spec.path}:`, error);
		}
	}
}

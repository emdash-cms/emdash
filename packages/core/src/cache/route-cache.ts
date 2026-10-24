import type { APIContext } from "astro";

type RouteCache = Pick<APIContext["cache"], "enabled" | "invalidate">;

/**
 * Purge `tags` from Astro's route cache when a cache provider is configured.
 *
 * Never throws: callers run it after a committed write, and a rejected purge
 * must not fail that write. The pages stay cached until a later purge or their
 * `maxAge`.
 */
export async function invalidateRouteCache(
	cache: RouteCache | undefined,
	tags: string[],
): Promise<void> {
	if (!cache?.enabled) return;
	try {
		await cache.invalidate({ tags });
	} catch (error) {
		console.error(`[cache] Failed to invalidate route cache tags ${tags.join(", ")}:`, error);
	}
}

/**
 * Reserved route-cache tags for EmDash-managed, non-content data that renders
 * on many pages (site settings, menus). Content entries already tag with their
 * ULID + collection slug via the loader's `cacheHint`; settings and menus have
 * no per-entry identity, so they share a single reserved tag.
 *
 * Write paths purge the matching tag, which evicts every cached page that
 * opted into it — closing the gap where editing the navigation or a site
 * setting never invalidated rendered HTML (#2042). Pages opt in by adding the
 * tag to their route cache (e.g. `Astro.cache.set({ tags: [EDGE_TAG_MENUS] })`
 * in the layout that renders the menu).
 */

import type { APIContext } from "astro";

/** Route-cache tag invalidated whenever site settings change. */
export const EDGE_TAG_SETTINGS = "emdash:settings";

/** Route-cache tag invalidated whenever any menu changes. */
export const EDGE_TAG_MENUS = "emdash:menus";

/**
 * Purge one of the reserved edge-cache tags after a settings/menu write.
 * No-op when no route-cache provider is configured (`cache.enabled` false) —
 * same contract as the content write paths. Accepts the request's
 * `APIContext["cache"]` so route handlers stay one-liners.
 */
export async function invalidateEdgeTag(
	cache: APIContext["cache"] | undefined,
	tag: string,
): Promise<void> {
	if (cache?.enabled) await cache.invalidate({ tags: [tag] });
}

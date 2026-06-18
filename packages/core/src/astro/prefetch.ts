/**
 * Eager, transparent prefetch of site-global "chrome" data.
 *
 * On a public page render, the shared layout pulls the same site-global data on
 * every request -- menus, widget areas, taxonomy term lists, site settings --
 * but each is awaited inside a separately-rendered Astro component, so they
 * execute as serial DB round trips. This fires them all CONCURRENTLY at the
 * very start of the request, before `next()`:
 *
 *   - On remote backends (D1, Durable Objects) the round trips overlap instead
 *     of serializing, collapsing ~N sequential RTTs into ~1 wall-clock RTT. On
 *     a coalescing backend they additionally batch into a single round trip.
 *   - The results land in the per-request `requestCached` store under the exact
 *     keys the layout helpers use, so when the components render they hit a warm
 *     (in-flight or resolved) cache entry instead of issuing their own query.
 *
 * Nothing here changes what templates call -- it warms the real helpers, so the
 * cache keys and value shapes are guaranteed identical. The caller gates this to
 * the public-page path on a request-scoped (remote) backend; it is a no-op-ish
 * waste on synchronous local SQLite, so don't call it there.
 *
 * Fire-and-forget: never awaited by middleware, never throws (a prefetch failure
 * must not affect the request -- the helpers will simply run on demand).
 */

import { getDb } from "../loader.js";
import { getMenu } from "../menus/index.js";
import { setRequestCacheEntry } from "../request-cache.js";
import { getSiteSettings } from "../settings/index.js";
import { getTaxonomyDefs, getTaxonomyTerms } from "../taxonomies/index.js";
import { getWidgetAreas } from "../widgets/index.js";

/** Warm widget areas: one bulk load, primed under each per-area cache key. */
async function prefetchWidgetAreas(): Promise<void> {
	const areas = await getWidgetAreas();
	// getWidgetArea(name) caches under `widget-area:${name}` and returns the same
	// WidgetArea shape getWidgetAreas yields, so priming here makes those calls hit.
	for (const area of areas) {
		setRequestCacheEntry(`widget-area:${area.name}`, area);
	}
}

/** Warm every taxonomy's term list via the real helper (primes per-name keys). */
async function prefetchTaxonomyTerms(): Promise<void> {
	const defs = await getTaxonomyDefs();
	await Promise.allSettled(defs.map((def) => getTaxonomyTerms(def.name)));
}

/** Warm every menu via the real helper (primes `menu:${name}:${locale}`). */
async function prefetchMenus(): Promise<void> {
	const db = await getDb();
	// The layout calls getMenu(name) with hardcoded names; we can't know them, so
	// discover every menu name and warm them all (small, bounded chrome table).
	const rows = await db.selectFrom("_emdash_menus").select("name").distinct().execute();
	const names = [...new Set(rows.map((r) => r.name))];
	await Promise.allSettled(names.map((name) => getMenu(name)));
}

/**
 * Concurrently warm the site-global layout data for the current request.
 * Safe to call only inside the request ALS frame that owns the (remote)
 * request-scoped db. Never throws.
 */
export async function prefetchLayoutData(): Promise<void> {
	try {
		await Promise.allSettled([
			getSiteSettings(),
			prefetchMenus(),
			prefetchWidgetAreas(),
			prefetchTaxonomyTerms(),
		]);
	} catch (error) {
		// Defensive: Promise.allSettled shouldn't reject, but never let a prefetch
		// failure surface to the request.
		console.error("[emdash] layout prefetch failed (non-fatal):", error);
	}
}

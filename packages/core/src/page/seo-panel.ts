/**
 * Request-scoped hand-off of SEO panel data from the entry query to the
 * render components.
 *
 * The loader's single-entry path already folds the `_emdash_seo` row into
 * the entry query as a JSON subselect, so the panel data is in hand when an
 * entry is fetched — it primes this cache, and `<EmDashHead>` (plus the body
 * fragment components) pick the data up with a plain map read. No code path
 * here ever queries the database.
 *
 * Kept as a leaf module (request-cache only) so the loader and the query
 * layer can prime without importing the page-context machinery, which pulls
 * in site settings and would create an import cycle back into the loader.
 */

import type { ContentSeo } from "../database/repositories/types.js";
import { peekRequestCache, setRequestCacheEntry } from "../request-cache.js";

function seoPanelCacheKey(collection: string, id: string): string {
	return `seo-panel:${collection}:${id}`;
}

/**
 * Prime the request-scoped SEO panel cache for a content entry.
 *
 * Called wherever an entry's folded SEO data materializes: the loader's
 * single-entry path (fresh query) and the object-cache revive path in
 * `getEmDashEntry` (warm hit, where the loader never runs). No-ops outside
 * a request context; never overwrites an already-primed value.
 */
export function primeSeoPanel(collection: string, id: string, seo: ContentSeo): void {
	setRequestCacheEntry(seoPanelCacheKey(collection, id), seo);
}

/**
 * Read the SEO panel data primed for a content entry in this request.
 *
 * Returns `null` when nothing was primed — either the entry has no SEO
 * row, or it was not fetched through an EmDash loader in this request
 * (e.g. prerendered pages, or a hand-rolled query). Callers treat null as
 * "no overlay"; this never falls back to a database lookup, so the
 * logged-out hot path gains zero queries.
 */
export async function peekSeoPanel(collection: string, id: string): Promise<ContentSeo | null> {
	const primed = peekRequestCache<ContentSeo>(seoPanelCacheKey(collection, id));
	return primed ? await primed : null;
}

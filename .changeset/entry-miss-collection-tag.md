---
"emdash": patch
---

Fixes cached detail-page 404s staying stale after the missing entry is published. `getEmDashEntry` now returns the collection tag in `cacheHint` when no entry is found, so publishing the entry purges the cached 404. An entry found in the requested locale keeps only its own id and reference tags. An entry served from a fallback locale, or stored under a legacy locale code such as `en-US`, also carries the collection tag. On a site whose page passes no other cache hint, this can make a 404 cacheable for up to 60 seconds even without a route rule. To keep misses uncached, see [Error responses](https://docs.emdashcms.com/deployment/route-caching/#error-responses).

#### Upgrading

Pass the `getEmDashEntry` hint to `Astro.cache.set()` before rewriting to `/404`, as the templates now do, so the cached 404 is purged when the entry is published.

---
"emdash": patch
---

Allows content-miss 404s on public page routes with active cache options to be served from the cache for up to 60 seconds, instead of rendering on every request. With a route-cache provider configured, a tags-only hint from the 404 page or its layout can activate this behavior even without a route rule. Shorter lifetimes and explicit cache opt-outs are preserved, and stale-while-revalidate is disabled for these responses.

Keep the collection or taxonomy tag on the route rule so publishing the missing entry or saving the missing term purges its cached 404. Previously these responses were never cached. Sites whose rules lack the matching tag can now serve a stale 404 until its short lifetime expires; a failed purge has the same effect. Shipped template layouts supply settings and menu hints, not the missing content's collection or taxonomy tag, so their misses can remain cached after publication until this lifetime expires. To restore uncached misses, call `Astro.cache.set(false)` in the 404 page's frontmatter (or the miss branch for a directly returned 404), and skip any later layout calls that re-enable caching.

Cached 404 hits no longer reach the origin, so the admin's 404 hit counts exclude those requests. URLs that match no Astro route, internal paths, and paths ending in a file extension are unchanged.

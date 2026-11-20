---
"emdash": patch
---

Allows content-miss 404s on public page routes already opted into route caching to be served from the cache for up to 60 seconds, instead of rendering on every request. Shorter lifetimes and explicit cache opt-outs are preserved, and stale-while-revalidate is disabled for these responses.

Keep the collection or taxonomy tag on the route rule so publishing the missing entry or saving the missing term purges its cached 404. Previously these responses were never cached. Sites whose rules lack the matching tag can now serve a stale 404 until its short lifetime expires; a failed purge has the same effect. To restore uncached misses, call `Astro.cache.set(false)` in the miss branch or the 404 page's frontmatter, and skip any later layout calls that re-enable caching.

Cached 404 hits no longer reach the origin, so the admin's 404 hit counts exclude those requests. URLs that match no Astro route, internal paths, and paths ending in a file extension are unchanged.

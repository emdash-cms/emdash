---
"emdash": patch
---

Fixes stale route caches on Node after scheduled publishing or plugin content actions from hooks and cron tasks. Background purges become available once a non-prerendered request with route caching enabled accesses the EmDash runtime in that process. With `memoryCache()`, publishing invalidates the collection and entry tags so cached listings and articles refresh on the next request rather than waiting for expiry; other server processes retain their own caches until they expire.

With a compatible media cache provider, Node hook/cron media deletes and hourly cleanup also purge removed images once a route-cache-enabled request has accessed the EmDash runtime in that process. This does not enable automatic media caching with `memoryCache()`.

---
"emdash": patch
---

Fixes stale route caches on Node after scheduled publishing or plugin content actions from hooks and cron tasks. With `memoryCache()`, publishing invalidates the collection and entry tags in the publishing process, so cached listings and articles refresh on the next request rather than waiting for expiry. Other server processes retain their own caches until they expire.
